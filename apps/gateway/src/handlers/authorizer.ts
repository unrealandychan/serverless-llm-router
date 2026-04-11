import type {
    APIGatewayTokenAuthorizerEvent,
    APIGatewayAuthorizerResult,
} from 'aws-lambda';
import { validateKey } from '../auth/keyStore';

/**
 * TOKEN-type Lambda Authorizer.
 *
 * API Gateway calls this before invoking any protected method.
 * A valid key returns an Allow policy + tenantId in context.
 * An invalid key returns a Deny policy → API Gateway responds 403, the main Lambda is never invoked.
 * Results are cached at API Gateway for `resultsCacheTtl` (default 5 minutes per token).
 */
export const handler = async (
    event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
    const raw = event.authorizationToken ?? '';
    // Strip "Bearer " prefix (case-insensitive)
    const token = raw.replace(/^bearer\s+/i, '').trim();

    if (!token) {
        return buildPolicy('anonymous', 'Deny', event.methodArn, {});
    }

    let record: Awaited<ReturnType<typeof validateKey>>;
    try {
        record = await validateKey(token);
    } catch (err) {
        console.error(JSON.stringify({ message: 'Key store lookup failed', error: String(err) }));
        // Fail closed: deny on internal error rather than accidentally allowing access
        return buildPolicy('unknown', 'Deny', event.methodArn, {});
    }

    if (!record) {
        return buildPolicy(token, 'Deny', event.methodArn, {});
    }

    return buildPolicy(record.tenantId, 'Allow', event.methodArn, {
        tenantId: record.tenantId,
        label: record.label ?? '',
    });
};

function buildPolicy(
    principalId: string,
    effect: 'Allow' | 'Deny',
    methodArn: string,
    context: Record<string, string>,
): APIGatewayAuthorizerResult {
    // Scope the policy to the whole API so the cached result covers all methods/stages.
    // methodArn format: arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{method}/{path}
    // Replace the last method+path segments with a wildcard.
    const arnParts = methodArn.split(':');
    const apiGatewayArn = arnParts.slice(0, 5).join(':');
    const apiParts = (arnParts[5] ?? '').split('/');
    const wildcardArn = `${apiGatewayArn}:${apiParts[0]}/${apiParts[1] ?? '*'}/*/*`;

    return {
        principalId,
        policyDocument: {
            Version: '2012-10-17',
            Statement: [
                {
                    Action: 'execute-api:Invoke',
                    Effect: effect,
                    Resource: wildcardArn,
                },
            ],
        },
        context,
    };
}
