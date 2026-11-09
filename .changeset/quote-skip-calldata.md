---
'@eth-optimism/actions-sdk': minor
---

Skip calldata on read-only swap quotes and execution bundles on read-only borrow quotes.

`actions.swap.getQuote` and `actions.swap.getQuotes` no longer encode router calldata. `actions.borrow.getQuote` returns position, fee, and safe-ceiling fields without a transaction bundle. Wallet quote and execute paths still return full executable data. Executing a read-only quote throws `QuoteExecutionMissingError`.
