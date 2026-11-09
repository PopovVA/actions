import { BaseSwapNamespace } from '@/actions/swap/namespaces/BaseSwapNamespace.js'
import { asSwapQuotePreview } from '@/actions/swap/quoteExecution.js'
import type { SwapQuoteParams, SwapQuotePreview } from '@/types/swap/index.js'

/**
 * Actions swap namespace (read-only, no wallet required).
 * Provides getQuote(), getMarket(), and getMarkets() for read-only access without a wallet.
 * Quotes skip calldata encoding; re-quote on the wallet namespace to execute.
 */
export class ActionsSwapNamespace extends BaseSwapNamespace {
  /**
   * Get a read-only swap quote.
   * @description Same routing as the wallet namespace, but providers skip
   * `encodeSwap` / `encodeCLSwap` / `encodeUniversalRouterSwap`.
   * @param params - Quote parameters (assets, amounts, chain, optional provider)
   * @returns Pricing and amounts, with `execution` omitted
   */
  override async getQuote(params: SwapQuoteParams): Promise<SwapQuotePreview> {
    return asSwapQuotePreview(await this.routeQuote(params, false))
  }

  /**
   * Fetch read-only quotes from eligible providers.
   * @description Same provider fan-out as the wallet namespace, without calldata.
   * @param params - Quote parameters (assets, amounts, chain, optional provider)
   * @returns Quotes sorted by amountOut descending, without calldata
   */
  override async getQuotes(
    params: SwapQuoteParams,
  ): Promise<SwapQuotePreview[]> {
    const quotes = await this.routeQuotes(params, false)
    return quotes.map((quote) => asSwapQuotePreview(quote))
  }
}
