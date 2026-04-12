import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';

const GATEWAY_SRC = path.resolve(__dirname, '../../../apps/gateway/src');
const DASHBOARD_DIR = path.resolve(__dirname, '../../../dashboard');

export class GatewayStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ─── Secrets ─────────────────────────────────────────────────────────────
        const openAiSecret = new secretsmanager.Secret(this, 'OpenAiApiKey', {
            secretName: '/llm-gateway/openai-api-key',
            description: 'OpenAI API key for the LLM gateway',
        });

        const anthropicSecret = new secretsmanager.Secret(this, 'AnthropicApiKey', {
            secretName: '/llm-gateway/anthropic-api-key',
            description: 'Anthropic API key for the LLM gateway',
        });

        const geminiSecret = new secretsmanager.Secret(this, 'GeminiApiKey', {
            secretName: '/llm-gateway/gemini-api-key',
            description: 'Gemini API key for OpenAI-compatible Gemini endpoint',
        });

        const vertexSecret = new secretsmanager.Secret(this, 'VertexCredentialsJson', {
            secretName: '/llm-gateway/vertex-credentials-json',
            description: 'Vertex credentials JSON for OpenAI-compatible Vertex endpoint (service account or WIF credentials)',
        });

        // Gateway API keys: JSON map of { "<token>": { "tenantId": "...", "label": "..." } }
        // Populate AFTER deploy: aws secretsmanager put-secret-value --secret-id /llm-gateway/api-keys --secret-string '{"gw_sk_changeme":{"tenantId":"t_default","label":"default"}}'
        const apiKeysSecret = new secretsmanager.Secret(this, 'ApiKeys', {
            secretName: '/llm-gateway/api-keys',
            description: 'Gateway API keys map — { "<token>": { "tenantId": string, "label": string } }',
        });

        // ─── DynamoDB ─────────────────────────────────────────────────────────────
        const table = new dynamodb.Table(this, 'RequestLogs', {
            partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // GSI1: look up a single request by ID
        table.addGlobalSecondaryIndex({
            indexName: 'GSI1-requestId',
            partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // GSI2: all requests for a model alias, ordered by time
        table.addGlobalSecondaryIndex({
            indexName: 'GSI2-modelAlias',
            partitionKey: { name: 'modelAlias', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // GSI3: requests by provider#status (e.g. "openai#failed"), ordered by time
        table.addGlobalSecondaryIndex({
            indexName: 'GSI3-providerStatus',
            partitionKey: { name: 'providerStatus', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // ─── DynamoDB — Dynamic Route Config ─────────────────────────────────────
        // Rows override the static modelMap at runtime. PK = alias (e.g. "fast").
        const routesTable = new dynamodb.Table(this, 'Routes', {
            partitionKey: { name: 'alias', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // ─── DynamoDB — Rate Limit Counters ───────────────────────────────────────
        // PK = "{tenantId}#minute#{YYYYMMDDTHHMM}" or "{tenantId}#day#{YYYYMMDD}"
        const rateLimitsTable = new dynamodb.Table(this, 'RateLimits', {
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ─── SQS ─────────────────────────────────────────────────────────────────
        const auditDlq = new sqs.Queue(this, 'AuditDlq', {
            queueName: 'llm-gateway-audit-dlq',
            retentionPeriod: cdk.Duration.days(14),
        });

        const auditQueue = new sqs.Queue(this, 'AuditQueue', {
            queueName: 'llm-gateway-audit',
            visibilityTimeout: cdk.Duration.seconds(30),
            deadLetterQueue: { queue: auditDlq, maxReceiveCount: 3 },
        });

        // ─── Shared bundling options ──────────────────────────────────────────────
        const nodejsFnProps: Omit<lambdaNodejs.NodejsFunctionProps, 'entry' | 'handler'> = {
            runtime: lambda.Runtime.NODEJS_22_X,
            architecture: lambda.Architecture.ARM_64,
            bundling: {
                // AWS SDK v3 is available in the Lambda Node.js 22 runtime — no need to bundle it
                externalModules: ['@aws-sdk/*'],
                sourceMap: true,
                minify: false,
            },
            environment: {
                NODE_OPTIONS: '--enable-source-maps',
            },
            logRetention: logs.RetentionDays.ONE_MONTH,
        };

        // Env vars common to all request-handling Lambdas
        const sharedRequestEnv = {
            ...nodejsFnProps.environment,
            OPENAI_SECRET_ARN: openAiSecret.secretArn,
            ANTHROPIC_SECRET_ARN: anthropicSecret.secretArn,
            OPENAI_COMPAT_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
            OPENAI_COMPAT_GEMINI_SECRET_ARN: geminiSecret.secretArn,
            OPENAI_COMPAT_VERTEX_BASE_URL:
                'https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_VERTEX_PROJECT/locations/us-central1/endpoints/openapi',
            OPENAI_COMPAT_VERTEX_CREDENTIALS_SECRET_ARN: vertexSecret.secretArn,
            ROUTES_TABLE_NAME: routesTable.tableName,
            RATE_LIMITS_TABLE_NAME: rateLimitsTable.tableName,
            RPM_LIMIT: '60',
            RPD_LIMIT: '1000',
        };

        // ─── Lambda Authorizer ────────────────────────────────────────────────────
        const authorizerFn = new lambdaNodejs.NodejsFunction(this, 'Authorizer', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-authorizer',
            entry: path.join(GATEWAY_SRC, 'handlers/authorizer.ts'),
            handler: 'handler',
            memorySize: 128,
            timeout: cdk.Duration.seconds(10),
            environment: {
                ...nodejsFnProps.environment,
                API_KEYS_SECRET_ARN: apiKeysSecret.secretArn,
            },
        });

        apiKeysSecret.grantRead(authorizerFn);

        const tokenAuthorizer = new apigw.TokenAuthorizer(this, 'ApiKeyAuthorizer', {
            handler: authorizerFn,
            // Cache the Allow/Deny result per unique token for 5 minutes.
            // This means a valid key will not re-invoke the authorizer Lambda within that window.
            resultsCacheTtl: cdk.Duration.minutes(5),
            identitySource: 'method.request.header.Authorization',
            authorizerName: 'ApiKeyAuthorizer',
        });

        // ─── Log Consumer Lambda ──────────────────────────────────────────────────
        const logConsumerFn = new lambdaNodejs.NodejsFunction(this, 'LogConsumer', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-log-consumer',
            entry: path.join(GATEWAY_SRC, 'logging/logConsumer.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            environment: {
                ...nodejsFnProps.environment,
                TABLE_NAME: table.tableName,
            },
        });

        table.grantWriteData(logConsumerFn);

        logConsumerFn.addEventSource(
            new sources.SqsEventSource(auditQueue, {
                batchSize: 10,
                reportBatchItemFailures: true,
            }),
        );

        // ─── List Models Lambda ───────────────────────────────────────────────────
        const listModelsFn = new lambdaNodejs.NodejsFunction(this, 'ListModels', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-list-models',
            entry: path.join(GATEWAY_SRC, 'handlers/listModels.ts'),
            handler: 'handler',
            memorySize: 128,
            timeout: cdk.Duration.seconds(10),
            environment: {
                ...nodejsFnProps.environment,
                ROUTES_TABLE_NAME: routesTable.tableName,
            },
        });
        routesTable.grantReadData(listModelsFn);

        // ─── Gateway Lambda (streaming) ───────────────────────────────────────────
        const gatewayFn = new lambdaNodejs.NodejsFunction(this, 'Gateway', {
            ...nodejsFnProps,
            functionName: 'llm-gateway',
            entry: path.join(GATEWAY_SRC, 'handlers/chatCompletions.ts'),
            handler: 'handler',
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            environment: {
                ...sharedRequestEnv,
                AUDIT_QUEUE_URL: auditQueue.queueUrl,
            },
        });
        auditQueue.grantSendMessages(gatewayFn);
        openAiSecret.grantRead(gatewayFn);
        anthropicSecret.grantRead(gatewayFn);
        geminiSecret.grantRead(gatewayFn);
        vertexSecret.grantRead(gatewayFn);
        routesTable.grantReadData(gatewayFn);
        rateLimitsTable.grantReadWriteData(gatewayFn);
        // Bedrock uses the Lambda execution role — no secret needed
        gatewayFn.addToRolePolicy(
            new iam.PolicyStatement({
                actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                resources: ['arn:aws:bedrock:*::foundation-model/*'],
            }),
        );

        // ─── Embeddings Lambda ────────────────────────────────────────────────────
        const embeddingsFn = new lambdaNodejs.NodejsFunction(this, 'Embeddings', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-embeddings',
            entry: path.join(GATEWAY_SRC, 'handlers/embeddings.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            environment: { ...sharedRequestEnv },
        });
        openAiSecret.grantRead(embeddingsFn);
        rateLimitsTable.grantReadWriteData(embeddingsFn);

        // ─── Image Generations Lambda ─────────────────────────────────────────────
        const imageGenFn = new lambdaNodejs.NodejsFunction(this, 'ImageGenerations', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-image-generations',
            entry: path.join(GATEWAY_SRC, 'handlers/imageGenerations.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(60),
            environment: { ...sharedRequestEnv },
        });
        openAiSecret.grantRead(imageGenFn);
        rateLimitsTable.grantReadWriteData(imageGenFn);

        // ─── Audio Transcriptions Lambda ──────────────────────────────────────────
        const audioTranscribeFn = new lambdaNodejs.NodejsFunction(this, 'AudioTranscriptions', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-audio-transcriptions',
            entry: path.join(GATEWAY_SRC, 'handlers/audioTranscriptions.ts'),
            handler: 'handler',
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            environment: { ...sharedRequestEnv },
        });
        openAiSecret.grantRead(audioTranscribeFn);
        rateLimitsTable.grantReadWriteData(audioTranscribeFn);

        // ─── Audio Speech Lambda ──────────────────────────────────────────────────
        const audioSpeechFn = new lambdaNodejs.NodejsFunction(this, 'AudioSpeech', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-audio-speech',
            entry: path.join(GATEWAY_SRC, 'handlers/audioSpeech.ts'),
            handler: 'handler',
            memorySize: 512,
            timeout: cdk.Duration.seconds(60),
            environment: { ...sharedRequestEnv },
        });
        openAiSecret.grantRead(audioSpeechFn);
        rateLimitsTable.grantReadWriteData(audioSpeechFn);

        // ─── Billing Usage Lambda ─────────────────────────────────────────────────
        const billingUsageFn = new lambdaNodejs.NodejsFunction(this, 'BillingUsage', {
            ...nodejsFnProps,
            functionName: 'llm-gateway-billing-usage',
            entry: path.join(GATEWAY_SRC, 'handlers/billingUsage.ts'),
            handler: 'handler',
            memorySize: 256,
            timeout: cdk.Duration.seconds(30),
            environment: {
                ...nodejsFnProps.environment,
                TABLE_NAME: table.tableName,
            },
        });
        table.grantReadData(billingUsageFn);

        // ─── API Gateway REST API ─────────────────────────────────────────────────
        const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
            retention: logs.RetentionDays.ONE_MONTH,
        });

        const api = new apigw.RestApi(this, 'Api', {
            restApiName: 'llm-gateway',
            description: 'Serverless LLM Router',
            deployOptions: {
                stageName: 'v1',
                metricsEnabled: true,
                loggingLevel: apigw.MethodLoggingLevel.ERROR,
                accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
                accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
            },
            defaultCorsPreflightOptions: {
                allowOrigins: apigw.Cors.ALL_ORIGINS,
                allowMethods: ['POST', 'GET', 'OPTIONS'],
                allowHeaders: ['Content-Type', 'Authorization'],
            },
        });

        const v1 = api.root.addResource('v1');

        const authOpts = {
            authorizer: tokenAuthorizer,
            authorizationType: apigw.AuthorizationType.CUSTOM,
        };

        // ── GET /v1/models ────────────────────────────────────────────────────────
        v1.addResource('models').addMethod('GET', new apigw.LambdaIntegration(listModelsFn), authOpts);

        // ── POST /v1/chat/completions (streaming) ─────────────────────────────────
        //
        // Standard LambdaIntegration uses the "/invocations" URI.
        // For Lambda response streaming we must use "/response-streaming-invocations"
        // and override ResponseTransferMode=STREAMING via a CFN escape hatch.
        // See: https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

        const streamingUri = cdk.Fn.join('', [
            'arn:',
            cdk.Aws.PARTITION,
            ':apigateway:',
            cdk.Aws.REGION,
            ':lambda:path/2021-11-15/functions/',
            gatewayFn.functionArn,
            '/response-streaming-invocations',
        ]);

        const streamIntegration = new apigw.Integration({
            type: apigw.IntegrationType.AWS_PROXY,
            integrationHttpMethod: 'POST',
            uri: streamingUri,
        });

        const chatResource = v1.addResource('chat').addResource('completions');
        const chatMethod = chatResource.addMethod('POST', streamIntegration, {
            authorizer: tokenAuthorizer,
            authorizationType: apigw.AuthorizationType.CUSTOM,
            methodResponses: [
                {
                    statusCode: '200',
                    responseParameters: {
                        'method.response.header.Content-Type': true,
                        'method.response.header.X-Request-Id': true,
                    },
                },
            ],
        });

        // CFN escape hatch: set ResponseTransferMode=STREAM on the integration
        const cfnMethod = chatMethod.node.defaultChild as apigw.CfnMethod;
        cfnMethod.addOverride('Properties.Integration.ResponseTransferMode', 'STREAM');

        // Allow API Gateway to invoke the Gateway Lambda via the streaming invocations path
        gatewayFn.addPermission('ApiGwStreamInvoke', {
            principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
            action: 'lambda:InvokeFunction',
            sourceArn: api.arnForExecuteApi('POST', '/v1/chat/completions', 'v1'),
        });

        // ── POST /v1/embeddings ───────────────────────────────────────────────────
        v1.addResource('embeddings').addMethod(
            'POST',
            new apigw.LambdaIntegration(embeddingsFn),
            authOpts,
        );

        // ── POST /v1/images/generations ───────────────────────────────────────────
        const imagesResource = v1.addResource('images');
        imagesResource.addResource('generations').addMethod(
            'POST',
            new apigw.LambdaIntegration(imageGenFn),
            authOpts,
        );

        // ── POST /v1/audio/transcriptions & /v1/audio/speech ──────────────────────
        const audioResource = v1.addResource('audio');
        audioResource.addResource('transcriptions').addMethod(
            'POST',
            new apigw.LambdaIntegration(audioTranscribeFn),
            authOpts,
        );
        audioResource.addResource('speech').addMethod(
            'POST',
            new apigw.LambdaIntegration(audioSpeechFn),
            authOpts,
        );

        // ── GET /v1/billing/usage ─────────────────────────────────────────────────
        const billingResource = v1.addResource('billing');
        billingResource.addResource('usage').addMethod(
            'GET',
            new apigw.LambdaIntegration(billingUsageFn),
            authOpts,
        );

        // ─── Billing Dashboard — S3 + CloudFront ──────────────────────────────────
        const dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: false,
        });

        const oac = new cloudfront.S3OriginAccessControl(this, 'DashboardOAC', {
            signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
        });

        const distribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
            defaultBehavior: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket, {
                    originAccessControl: oac,
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
            },
            defaultRootObject: 'index.html',
            errorResponses: [
                { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
                { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
            ],
            priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        });

        new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
            sources: [s3deploy.Source.asset(DASHBOARD_DIR)],
            destinationBucket: dashboardBucket,
            distribution,
            distributionPaths: ['/*'],
        });

        // ─── Outputs ──────────────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'ApiUrl', {
            value: api.url,
            description: 'API Gateway base URL',
        });

        new cdk.CfnOutput(this, 'ChatEndpoint', {
            value: `${api.url}v1/chat/completions`,
            description: 'Chat completions endpoint',
        });

        new cdk.CfnOutput(this, 'EmbeddingsEndpoint', {
            value: `${api.url}v1/embeddings`,
            description: 'Embeddings endpoint',
        });

        new cdk.CfnOutput(this, 'BillingEndpoint', {
            value: `${api.url}v1/billing/usage`,
            description: 'Billing usage endpoint',
        });

        new cdk.CfnOutput(this, 'DashboardUrl', {
            value: `https://${distribution.distributionDomainName}`,
            description: 'Billing dashboard URL (CloudFront)',
        });

        new cdk.CfnOutput(this, 'TableName', {
            value: table.tableName,
            description: 'DynamoDB request log table',
        });

        new cdk.CfnOutput(this, 'RoutesTableName', {
            value: routesTable.tableName,
            description: 'DynamoDB dynamic routes table',
        });

        new cdk.CfnOutput(this, 'AuditQueueUrl', {
            value: auditQueue.queueUrl,
            description: 'SQS audit queue URL',
        });

        new cdk.CfnOutput(this, 'OpenAiSecretArn', {
            value: openAiSecret.secretArn,
            description: 'Secrets Manager ARN — populate with your OpenAI API key',
        });

        new cdk.CfnOutput(this, 'AnthropicSecretArn', {
            value: anthropicSecret.secretArn,
            description: 'Secrets Manager ARN — populate with your Anthropic API key',
        });

        new cdk.CfnOutput(this, 'GeminiSecretArn', {
            value: geminiSecret.secretArn,
            description: 'Secrets Manager ARN — populate with your Gemini API key',
        });

        new cdk.CfnOutput(this, 'VertexSecretArn', {
            value: vertexSecret.secretArn,
            description: 'Secrets Manager ARN — populate with Vertex credentials JSON',
        });

        new cdk.CfnOutput(this, 'ApiKeysSecretArn', {
            value: apiKeysSecret.secretArn,
            description: 'Secrets Manager ARN — populate with gateway API keys JSON map',
        });
    }
}
