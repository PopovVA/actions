import type { PublicClient } from 'viem'

import type { QuoteAmounts } from '@/actions/borrow/core/quote.js'
import { encodeAaveBorrow } from '@/actions/borrow/providers/aave/calldata.js'
import {
  type AavePositionState,
  type AaveReservePrices,
  type AssembleAaveQuoteArgs,
  projectAavePositionState,
} from '@/actions/borrow/providers/aave/presentation.js'
import { fetchAaveStateAndPrices } from '@/actions/borrow/providers/aave/prices.js'
import {
  buildAaveCollateralDeposit,
  buildAaveCollateralWithdraw,
  buildAaveRepay,
  resolveAaveAmount,
} from '@/actions/borrow/providers/aave/write.js'
import { EmptyPositionError, InvalidParamsError } from '@/core/error/errors.js'
import type {
  AaveBorrowMarketConfig,
  BorrowAction,
  BorrowClosePositionInternalParams,
  BorrowDepositCollateralInternalParams,
  BorrowOpenPositionInternalParams,
  BorrowRepayInternalParams,
  BorrowWithdrawCollateralInternalParams,
} from '@/types/borrow/index.js'
import type { TransactionData } from '@/types/transaction.js'

/**
 * The `assembleAaveBorrowQuote` arguments minus the provider-resolved settings
 * (`recipient`, expiration, health buffer), returned by each
 * `buildAave*QuoteArgs`.
 */
export type AaveQuoteArgs = Omit<
  AssembleAaveQuoteArgs,
  'recipient' | 'quoteExpirationSeconds' | 'healthBufferPct'
>

function project(
  current: AavePositionState,
  prices: AaveReservePrices,
  market: AaveBorrowMarketConfig,
  delta: { collateralDelta: bigint; debtDelta: bigint },
): AavePositionState {
  return projectAavePositionState(current, prices, delta, {
    collateral: market.collateralAsset.metadata.decimals,
    debt: market.borrowAsset.metadata.decimals,
  })
}

/**
 * Shared tail of every `buildAave*QuoteArgs`: project the resulting position
 * from the signed deltas and wrap it in the quote-args envelope. Each action
 * differs only in the `plan` it computes (txs, deltas, amounts); this owns the
 * project-and-assemble scaffold so that logic lives in one place.
 */
function finalizePlan(
  market: AaveBorrowMarketConfig,
  current: AavePositionState,
  prices: AaveReservePrices,
  plan: {
    action: BorrowAction
    collateralDelta: bigint
    debtDelta: bigint
    transactions: TransactionData[]
    approvalsSkipped: boolean
    quoteAmounts: QuoteAmounts
    includeExecution?: boolean
  },
): AaveQuoteArgs {
  return {
    action: plan.action,
    market,
    positionBefore: current,
    positionAfter: project(current, prices, market, {
      collateralDelta: plan.collateralDelta,
      debtDelta: plan.debtDelta,
    }),
    transactions: plan.transactions,
    quoteAmounts: plan.quoteAmounts,
    approvalsSkipped: plan.approvalsSkipped,
    includeExecution: plan.includeExecution,
  }
}

export async function buildAaveOpenQuoteArgs(
  client: PublicClient,
  market: AaveBorrowMarketConfig,
  params: BorrowOpenPositionInternalParams,
  includeExecution = true,
): Promise<AaveQuoteArgs> {
  const { current, prices } = await fetchAaveStateAndPrices(
    client,
    market,
    params.walletAddress,
  )
  const collateral = params.collateralAmountWei ?? 0n
  const quoteAmounts = {
    borrowAmountRaw: params.borrowAmountWei,
    collateralAmountRaw: collateral > 0n ? collateral : undefined,
  }
  if (!includeExecution) {
    return finalizePlan(market, current, prices, {
      action: 'open',
      collateralDelta: collateral,
      debtDelta: params.borrowAmountWei,
      transactions: [],
      approvalsSkipped: true,
      quoteAmounts,
      includeExecution: false,
    })
  }
  const txs: TransactionData[] = []
  let approvalsSkipped = true
  if (collateral > 0n) {
    const deposit = await buildAaveCollateralDeposit({
      client,
      config: market,
      amount: collateral,
      user: params.walletAddress,
      approvalMode: params.approvalMode,
    })
    txs.push(...deposit.txs)
    approvalsSkipped = deposit.approvalsSkipped
  }
  txs.push(
    encodeAaveBorrow(market, params.borrowAmountWei, params.walletAddress),
  )
  return finalizePlan(market, current, prices, {
    action: 'open',
    collateralDelta: collateral,
    debtDelta: params.borrowAmountWei,
    transactions: txs,
    approvalsSkipped,
    quoteAmounts,
  })
}

export async function buildAaveRepayQuoteArgs(
  client: PublicClient,
  market: AaveBorrowMarketConfig,
  params: BorrowRepayInternalParams,
  includeExecution = true,
): Promise<AaveQuoteArgs> {
  const { current, prices } = await fetchAaveStateAndPrices(
    client,
    market,
    params.walletAddress,
  )
  const { txs, approvalsSkipped, repayAmount } = await buildAaveRepay({
    client,
    config: market,
    amount: params.amount,
    currentDebt: current.debtAmount,
    user: params.walletAddress,
    approvalMode: params.approvalMode,
    includeExecution,
  })
  return finalizePlan(market, current, prices, {
    action: 'repay',
    collateralDelta: 0n,
    debtDelta: -repayAmount,
    transactions: txs,
    approvalsSkipped,
    quoteAmounts: { borrowAmountRaw: repayAmount },
    includeExecution,
  })
}

export async function buildAaveDepositCollateralQuoteArgs(
  client: PublicClient,
  market: AaveBorrowMarketConfig,
  params: BorrowDepositCollateralInternalParams,
  includeExecution = true,
): Promise<AaveQuoteArgs> {
  // `max` is ambiguous for the native-ETH gateway path and unused (Aave
  // collateral is supplied at lend time); require an explicit amount.
  if ('max' in params.amount) {
    throw new InvalidParamsError({
      param: 'amount',
      expected:
        'an explicit amount (max is unsupported for Aave depositCollateral)',
    })
  }
  const amountWei = params.amount.amountWei
  const { current, prices } = await fetchAaveStateAndPrices(
    client,
    market,
    params.walletAddress,
  )
  if (!includeExecution) {
    return finalizePlan(market, current, prices, {
      action: 'depositCollateral',
      collateralDelta: amountWei,
      debtDelta: 0n,
      transactions: [],
      approvalsSkipped: true,
      quoteAmounts: { collateralAmountRaw: amountWei },
      includeExecution: false,
    })
  }
  const { txs, approvalsSkipped } = await buildAaveCollateralDeposit({
    client,
    config: market,
    amount: amountWei,
    user: params.walletAddress,
    approvalMode: params.approvalMode,
  })
  return finalizePlan(market, current, prices, {
    action: 'depositCollateral',
    collateralDelta: amountWei,
    debtDelta: 0n,
    transactions: txs,
    approvalsSkipped,
    quoteAmounts: { collateralAmountRaw: amountWei },
  })
}

export async function buildAaveWithdrawCollateralQuoteArgs(
  client: PublicClient,
  market: AaveBorrowMarketConfig,
  params: BorrowWithdrawCollateralInternalParams,
  includeExecution = true,
): Promise<AaveQuoteArgs> {
  const { current, prices } = await fetchAaveStateAndPrices(
    client,
    market,
    params.walletAddress,
  )
  const { amount, isMax } = resolveAaveAmount(
    params.amount,
    current.collateralAmount,
  )
  if (isMax && current.collateralAmount === 0n) {
    throw new EmptyPositionError({ operation: 'withdrawCollateral' })
  }
  const txs = includeExecution
    ? await buildAaveCollateralWithdraw({
        client,
        config: market,
        amount,
        isMax,
        user: params.walletAddress,
        approvalMode: params.approvalMode,
      })
    : []
  return finalizePlan(market, current, prices, {
    action: 'withdrawCollateral',
    collateralDelta: -amount,
    debtDelta: 0n,
    transactions: txs,
    // Native-ETH withdraws prepend a gateway aToken approval; direct ones don't.
    approvalsSkipped: !includeExecution || txs.length === 1,
    quoteAmounts: { collateralAmountRaw: amount },
    includeExecution,
  })
}

export async function buildAaveCloseQuoteArgs(
  client: PublicClient,
  market: AaveBorrowMarketConfig,
  params: BorrowClosePositionInternalParams,
  includeExecution = true,
): Promise<AaveQuoteArgs> {
  const { current, prices } = await fetchAaveStateAndPrices(
    client,
    market,
    params.walletAddress,
  )
  const repay = await buildAaveRepay({
    client,
    config: market,
    amount: params.borrowAmount,
    currentDebt: current.debtAmount,
    user: params.walletAddress,
    approvalMode: params.approvalMode,
    includeExecution,
  })
  const txs = [...repay.txs]

  let collateralDelta = 0n
  let withdrawApprovalsSkipped = true
  if (params.collateralAmount !== undefined) {
    const { amount: withdrawAmount, isMax } = resolveAaveAmount(
      params.collateralAmount,
      current.collateralAmount,
    )
    // A max close with no collateral has nothing to withdraw; emitting a
    // withdraw-all leg would revert, so the repay proceeds on its own.
    if (!(isMax && current.collateralAmount === 0n)) {
      collateralDelta = -withdrawAmount
      if (includeExecution) {
        const withdrawTxs = await buildAaveCollateralWithdraw({
          client,
          config: market,
          amount: withdrawAmount,
          isMax,
          user: params.walletAddress,
          approvalMode: params.approvalMode,
        })
        // Native-ETH withdraws prepend a gateway aToken approval.
        withdrawApprovalsSkipped = withdrawTxs.length === 1
        txs.push(...withdrawTxs)
      }
    }
  }

  return finalizePlan(market, current, prices, {
    action: 'close',
    collateralDelta,
    debtDelta: -repay.repayAmount,
    transactions: txs,
    approvalsSkipped: repay.approvalsSkipped && withdrawApprovalsSkipped,
    quoteAmounts: {
      borrowAmountRaw: repay.repayAmount,
      collateralAmountRaw: collateralDelta < 0n ? -collateralDelta : undefined,
    },
    includeExecution,
  })
}
