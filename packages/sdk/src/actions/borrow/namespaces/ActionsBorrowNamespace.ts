import { asBorrowQuotePreview } from '@/actions/borrow/core/quoteExecution.js'
import { BaseBorrowNamespace } from '@/actions/borrow/namespaces/BaseBorrowNamespace.js'
import type {
  BorrowQuoteParams,
  BorrowQuotePreview,
} from '@/types/borrow/index.js'

/**
 * Read-only borrow namespace exposed on `actions.borrow`.
 * @description Previews skip execution-bundle construction. Wallet methods
 * live on `WalletBorrowNamespace` and still return full quotes.
 */
export class ActionsBorrowNamespace extends BaseBorrowNamespace {
  /**
   * Preview a borrow action without building transactions.
   * @description Returns `positionAfter`, fees, and the safe-ceiling LTV.
   * `execution` is omitted. Dispatch through `wallet.borrow` to encode.
   * @param params - Discriminated borrow quote parameters.
   * @returns Borrow preview without a transaction bundle.
   * @throws ProviderNotConfiguredError when no provider can service the market.
   */
  override async getQuote(
    params: BorrowQuoteParams,
  ): Promise<BorrowQuotePreview> {
    return asBorrowQuotePreview(await this.buildQuote(params, false))
  }
}
