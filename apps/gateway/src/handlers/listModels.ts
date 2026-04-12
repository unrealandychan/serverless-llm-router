import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { loadRoutes } from '../config/routeLoader';
import { CORS_HEADERS } from '../util/cors';

export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const routes = await loadRoutes();

    const data = Object.entries(routes).map(([id, config]) => ({
        id,
        object: 'model',
        created: 1_714_000_000,
        owned_by: 'gateway',
        providers: [...new Set(config.targets.map((t) => t.provider))],
    }));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        body: JSON.stringify({ object: 'list', data }),
    };
};
