import { QuoteExecutionMissingError } from '@/core/error/errors.js'
import type { BorrowQuote, BorrowQuotePreview } from '@/types/borrow/index.js'

/**
 * @description True when the quote carries a pre-built transaction bundle.
 */
export function hasBorrowExecution(
  quote: BorrowQuote | BorrowQuotePreview,
): quote is BorrowQuote {
  return 'execution' in quote && quote.execution !== undefined
}

/**
 * @description Require an executable borrow quote.
 * @param quote - Full quote or a read-only preview.
 * @returns The same quote, narrowed to include `execution`.
 * @throws QuoteExecutionMissingError when the bundle was not built.
 */
export function requireBorrowExecution(
  quote: BorrowQuote | BorrowQuotePreview,
): BorrowQuote {
  if (!hasBorrowExecution(quote)) {
    throw new QuoteExecutionMissingError()
  }
  return quote
}

/**
 * @description Drop the transaction bundle so a preview cannot be dispatched.
 * @param quote - Quote that may still carry `execution`.
 * @returns Position, fee, and ceiling fields only.
 */
export function asBorrowQuotePreview(
  quote: BorrowQuote | BorrowQuotePreview,
): BorrowQuotePreview {
  if (!hasBorrowExecution(quote)) return quote
  const { execution: _execution, ...preview } = quote
  return preview
}
