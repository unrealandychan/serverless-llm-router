import { RouteConfig, ProviderTarget, modelMap } from '../config/modelMap';
import { ModelNotFoundError, isRetryableError } from '../util/errors';

export { RouteConfig, ProviderTarget };

/**
 * Look up a model alias in the routing config.
 * Throws ModelNotFoundError if the alias is not configured.
 */
export function resolveAlias(
  alias: string,
  config: Record<string, RouteConfig> = modelMap,
): RouteConfig {
  const route = config[alias];
  if (!route) throw new ModelNotFoundError(alias);
  return route;
}

/**
 * Select one target from a weighted list using random weighted selection.
 * The last target is always the fallback to handle floating-point edge cases.
 */
export function selectTarget(targets: ProviderTarget[]): ProviderTarget {
  if (targets.length === 0) throw new Error('No targets configured for this alias');
  if (targets.length === 1) return targets[0];

  const total = targets.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * total;
  for (const target of targets) {
    rand -= target.weight;
    if (rand <= 0) return target;
  }
  return targets[targets.length - 1];
}

export type FallbackInvokeResult<T> = {
  result: T;
  provider: string;
  providerModel: string;
};

/**
 * Resolve an alias and invoke the selected target.
 * On retryable errors, falls back through the configured fallback chain.
 * A visited-set prevents cycles between aliases.
 */
export async function routeWithFallback<T>(
  alias: string,
  invoke: (provider: string, providerModel: string) => Promise<T>,
  config: Record<string, RouteConfig> = modelMap,
): Promise<FallbackInvokeResult<T>> {
  const queue: string[] = [alias];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const route = config[current];
    if (!route) continue;

    const target = selectTarget(route.targets);
    try {
      const result = await invoke(target.provider, target.model);
      return { result, provider: target.provider, providerModel: target.model };
    } catch (err) {
      if (isRetryableError(err) && route.fallbacks?.length) {
        queue.push(...route.fallbacks.filter((f) => !visited.has(f)));
      } else {
        throw err;
      }
    }
  }

  // All fallbacks exhausted
  throw new ModelNotFoundError(alias);
}
