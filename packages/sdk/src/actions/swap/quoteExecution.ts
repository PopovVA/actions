import { QuoteExecutionMissingError } from '@/core/error/errors.js'
import type { SwapQuote, SwapQuotePreview } from '@/types/swap/index.js'

/**
 * @description True when the quote carries a pre-built swap bundle.
 */
export function hasSwapExecution(
  quote: SwapQuote | SwapQuotePreview,
): quote is SwapQuote {
  return 'execution' in quote && quote.execution !== undefined
}

/**
 * @description Require an executable swap quote.
 * @param quote - Full quote or a read-only preview.
 * @returns The same quote, narrowed to include `execution`.
 * @throws QuoteExecutionMissingError when calldata was not built.
 */
export function requireSwapExecution(
  quote: SwapQuote | SwapQuotePreview,
): SwapQuote {
  if (!hasSwapExecution(quote)) {
    throw new QuoteExecutionMissingError()
  }
  return quote
}

/**
 * @description Drop swap calldata so a read-only caller cannot submit it.
 * @param quote - Quote that may still carry `execution`.
 * @returns Pricing fields only.
 */
export function asSwapQuotePreview(
  quote: SwapQuote | SwapQuotePreview,
): SwapQuotePreview {
  if (!hasSwapExecution(quote)) return quote
  const { execution: _execution, ...preview } = quote
  return preview
}
