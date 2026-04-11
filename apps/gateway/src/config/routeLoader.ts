import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RouteConfig, modelMap } from './modelMap';

/** In-memory cache TTL for route config loaded from DynamoDB. */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedRoutes: Record<string, RouteConfig> | null = null;
let cacheExpiresAt = 0;

/**
 * Load the routing config from DynamoDB with a 5-minute in-memory cache.
 *
 * If ROUTES_TABLE_NAME is not set or the DynamoDB scan fails, falls back to
 * the static modelMap so the gateway keeps working without live config.
 *
 * DynamoDB item shape:
 *   alias  (String, PK) — "gpt-5.4", "fast", …
 *   targets (List)      — [{ provider, model, weight }, …]
 *   fallbacks (List?)   — ["gpt-5.2-codex", …]
 *   enabled  (Boolean?) — omit or true to include; false to disable
 */
export async function loadRoutes(): Promise<Record<string, RouteConfig>> {
    const now = Date.now();
    if (cachedRoutes && now < cacheExpiresAt) return cachedRoutes;

    const tableName = process.env.ROUTES_TABLE_NAME;
    if (!tableName) return modelMap;

    try {
        const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
        const result = await dynamo.send(new ScanCommand({ TableName: tableName }));

        // Merge: start with static config so anything not in DynamoDB still works.
        const routes: Record<string, RouteConfig> = { ...modelMap };

        for (const item of result.Items ?? []) {
            const alias = item['alias'] as string | undefined;
            const targets = item['targets'];
            const enabled = item['enabled'] as boolean | undefined;

            if (!alias || !Array.isArray(targets)) continue;
            if (enabled === false) {
                delete routes[alias];
                continue;
            }

            routes[alias] = {
                targets: targets as RouteConfig['targets'],
                fallbacks: Array.isArray(item['fallbacks'])
                    ? (item['fallbacks'] as string[])
                    : undefined,
            };
        }

        cachedRoutes = routes;
        cacheExpiresAt = now + CACHE_TTL_MS;
        return routes;
    } catch (err) {
        console.warn(
            JSON.stringify({
                message: 'Failed to load routes from DynamoDB — using static config',
                error: String(err),
            }),
        );
        return modelMap;
    }
}

/** Invalidate the route cache so the next call fetches fresh data. */
export function invalidateRouteCache(): void {
    cachedRoutes = null;
    cacheExpiresAt = 0;
}
