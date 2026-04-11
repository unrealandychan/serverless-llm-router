#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GatewayStack } from '../lib/gateway-stack';

const app = new cdk.App();

new GatewayStack(app, 'LlmGateway', {
    stackName: 'llm-gateway',
    description: 'Serverless LLM Router — API Gateway + Lambda + SQS + DynamoDB',
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
    },
});
