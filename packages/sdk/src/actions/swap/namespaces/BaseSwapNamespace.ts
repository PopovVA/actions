import { BaseNamespace } from '@/actions/shared/BaseNamespace.js'
import type { SwapProvider } from '@/actions/swap/core/SwapProvider.js'
import type { SupportedChainId } from '@/constants/supportedChains.js'
import {
  MarketNotAllowedError,
  MarketNotFoundError,
  ProviderNotConfiguredError,
} from '@/core/error/errors.js'
import type { SwapQuoteParamsResolved } from '@/services/nameservices/ens/types.js'
import {
  passthroughResolver,
  type RecipientResolver,
} from '@/services/nameservices/ens/utils.js'
import type { SwapProviderName, SwapSettings } from '@/types/actions.js'
import type { Asset } from '@/types/asset.js'
import type {
  GetSwapMarketParams,
  GetSwapMarketsParams,
  SwapMarket,
  SwapProviderConfig,
  SwapProviders,
  SwapQuote,
  SwapQuoteParams,
  SwapQuotePreview,
} from '@/types/swap/index.js'

type ConfiguredSwapProvider = SwapProvider<SwapProviderConfig>

/**
 * Base swap namespace with shared read-only operations
 */
export abstract class BaseSwapNamespace extends BaseNamespace<
  ConfiguredSwapProvider,
  SwapProviders
> {
  protected readonly resolveRecipient: RecipientResolver

  constructor(
    providers: SwapProviders,
    resolveRecipient?: RecipientResolver,
    protected readonly settings?: SwapSettings,
  ) {
    super(providers)
    this.resolveRecipient = resolveRecipient ?? passthroughResolver
  }

  /**
   * Get a swap quote with pre-built execution data.
   * When `routing: 'price'` is set in settings and no explicit provider is requested,
   * fetches quotes from all eligible providers in parallel and returns the best price.
   * Wallet namespaces keep this path. Read-only actions pass `includeCalldata: false`.
   * @param params - Quote parameters (assets, amounts, chain, optional provider)
   * @returns The best available SwapQuote
   */
  async getQuote(
    params: SwapQuoteParams,
  ): Promise<SwapQuote | SwapQuotePreview> {
    return this.routeQuote(params, true)
  }

  /**
   * Fetch quotes from all providers for the requested swap parameters.
   * Unlike getQuote(), returns all successful quotes instead of just the best.
   * If an explicit provider is specified, returns a single-element array from that provider.
   * @param params - Quote parameters (assets, amounts, chain, optional provider)
   * @returns Array of SwapQuotes sorted by amountOut descending (best first)
   */
  async getQuotes(
    params: SwapQuoteParams,
  ): Promise<Array<SwapQuote | SwapQuotePreview>> {
    return this.routeQuotes(params, true)
  }

  /**
   * Resolve a single quote. `includeCalldata` false skips router encoding.
   */
  protected async routeQuote(
    params: SwapQuoteParams,
    includeCalldata: boolean,
  ): Promise<SwapQuote | SwapQuotePreview> {
    const resolved = await this.resolveQuoteParams(params)
    if (resolved.provider || this.settings?.routing !== 'price') {
      return this.quoteFromProvider(resolved, includeCalldata)
    }
    return this.getBestQuote(resolved, includeCalldata)
  }

  /**
   * Resolve every successful quote, optionally without calldata.
   */
  protected async routeQuotes(
    params: SwapQuoteParams,
    includeCalldata: boolean,
  ): Promise<Array<SwapQuote | SwapQuotePreview>> {
    const resolved = await this.resolveQuoteParams(params)
    if (resolved.provider) {
      return [await this.quoteFromProvider(resolved, includeCalldata)]
    }
    const quotes = await this.fetchAllQuotes(resolved, includeCalldata)
    return quotes.sort((a, b) =>
      a.amountOutRaw > b.amountOutRaw
        ? -1
        : a.amountOutRaw < b.amountOutRaw
          ? 1
          : 0,
    )
  }

  /**
   * Get a specific swap market by ID.
   * @param params - Market identifier (poolId + chainId)
   * @param provider - Optional provider name to query directly instead of searching all
   * @returns Market information
   */
  async getMarket(
    params: GetSwapMarketParams,
    provider?: SwapProviderName,
  ): Promise<SwapMarket> {
    if (provider) {
      const named = this.providers[provider]
      if (!named) {
        throw new ProviderNotConfiguredError({ provider })
      }
      return named.getMarket(params)
    }

    for (const p of this.getAllProviders()) {
      try {
        return await p.getMarket(params)
      } catch {
        continue
      }
    }
    throw new MarketNotFoundError({
      chainId: params.chainId,
      poolId: params.poolId,
    })
  }

  /**
   * Get available swap markets across all providers
   * @param params - Optional filtering by chainId or asset
   * @returns Promise resolving to array of markets from all providers
   */
  async getMarkets(params: GetSwapMarketsParams = {}): Promise<SwapMarket[]> {
    const results = await Promise.all(
      this.getAllProviders().map((p) => p.getMarkets(params)),
    )
    return results.flat()
  }

  /**
   * Resolve which provider handles a request.
   *
   * Precedence:
   * 1. Explicit `provider` param on the call
   * 2. routing.defaultProvider (when no strategy set)
   * 3. routing.strategy match (market-aware, defaultProvider as tiebreaker)
   * 4. First provider whose allowlist matches
   * 5. First configured provider
   */
  protected resolveProvider(
    provider: SwapProviderName | undefined,
    assetIn: Asset,
    assetOut: Asset,
    chainId: SupportedChainId,
  ): ConfiguredSwapProvider {
    const allProviders = this.getAllProviders()
    if (allProviders.length === 0) {
      throw new ProviderNotConfiguredError({ provider: 'swap' })
    }

    // 1. Explicit provider param
    if (provider) {
      const named = this.providers[provider]
      if (!named) {
        throw new ProviderNotConfiguredError({ provider })
      }
      return named
    }

    // Single provider — no routing needed
    if (allProviders.length === 1) {
      return allProviders[0]
    }

    // 2. defaultProvider with no routing strategy — always use it
    if (this.settings?.defaultProvider && !this.settings.routing) {
      const provider = this.providers[this.settings.defaultProvider]
      if (provider) return provider
    }

    // 3. Match by market allowlist
    for (const p of allProviders) {
      if (p.isMarketSupported(assetIn, assetOut, chainId)) {
        return p
      }
    }

    // 4. Match by chain support
    for (const p of allProviders) {
      if (p.isChainSupported(chainId)) {
        return p
      }
    }

    return allProviders[0]
  }

  private async resolveQuoteParams(
    params: SwapQuoteParams,
  ): Promise<SwapQuoteParamsResolved> {
    const recipient = await this.resolveRecipient(params.recipient)
    return { ...params, recipient }
  }

  private quoteFromProvider(
    params: SwapQuoteParamsResolved,
    includeCalldata: boolean,
  ): Promise<SwapQuote | SwapQuotePreview> {
    const provider = this.resolveProvider(
      params.provider,
      params.assetIn,
      params.assetOut,
      params.chainId,
    )
    return includeCalldata
      ? provider.getQuote(params)
      : provider.getQuoteReadOnly(params)
  }

  /**
   * Fetch quotes from all eligible providers in parallel and return the best.
   * @param params - Quote parameters
   * @param includeCalldata - When false, skip calldata encoding
   * @returns The quote with the highest amountOut
   * @throws If no provider returns a valid quote
   */
  private async getBestQuote(
    params: SwapQuoteParamsResolved,
    includeCalldata: boolean,
  ): Promise<SwapQuote | SwapQuotePreview> {
    const quotes = await this.fetchAllQuotes(params, includeCalldata)

    let best: SwapQuote | SwapQuotePreview | null = null
    for (const quote of quotes) {
      if (!best || quote.amountOutRaw > best.amountOutRaw) {
        best = quote
      }
    }

    if (!best) {
      throw new MarketNotAllowedError({
        assetInSymbol: params.assetIn.metadata.symbol,
        assetOutSymbol: params.assetOut.metadata.symbol,
        chainId: params.chainId,
        reason: 'All providers failed to quote this pair',
      })
    }

    return best
  }

  /**
   * Fetch quotes from all eligible providers in parallel.
   * Providers that don't support the pair or fail to quote are silently skipped.
   * @param params - Quote parameters
   * @param includeCalldata - When false, skip calldata encoding
   * @returns Array of successful quotes (may be empty if all providers fail)
   */
  private async fetchAllQuotes(
    params: SwapQuoteParamsResolved,
    includeCalldata: boolean,
  ): Promise<Array<SwapQuote | SwapQuotePreview>> {
    const eligible = this.getAllProviders().filter((p) =>
      p.isMarketSupported(params.assetIn, params.assetOut, params.chainId),
    )

    if (eligible.length === 0) {
      throw new MarketNotAllowedError({
        assetInSymbol: params.assetIn.metadata.symbol,
        assetOutSymbol: params.assetOut.metadata.symbol,
        chainId: params.chainId,
        reason: 'No configured provider supports this pair on this chain',
      })
    }

    const results = await Promise.allSettled(
      eligible.map((p) =>
        includeCalldata ? p.getQuote(params) : p.getQuoteReadOnly(params),
      ),
    )

    return results
      .filter(
        (r): r is PromiseFulfilledResult<SwapQuote | SwapQuotePreview> =>
          r.status === 'fulfilled',
      )
      .map((r) => r.value)
  }
}
