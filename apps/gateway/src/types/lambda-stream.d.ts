// Type declarations for the Lambda response-streaming runtime globals.
// These are injected by the Lambda Node.js managed runtime and are not
// available as an npm package — declare them here so TypeScript is happy.

declare namespace awslambda {
    interface ResponseStreamMetadata {
        statusCode?: number;
        headers?: Record<string, string>;
    }

    interface WritableHttpResponseStream extends NodeJS.WritableStream {
        write(chunk: string | Buffer): boolean;
        end(): void;
    }

    interface HttpResponseStreamConstructor {
        from(
            wrappedStream: NodeJS.WritableStream,
            metadata: ResponseStreamMetadata,
        ): WritableHttpResponseStream;
    }

    const HttpResponseStream: HttpResponseStreamConstructor;

    type StreamifyHandler<TEvent = unknown> = (
        event: TEvent,
        responseStream: NodeJS.WritableStream,
    ) => Promise<void>;

    function streamifyResponse<TEvent = unknown>(
        handler: StreamifyHandler<TEvent>,
    ): (...args: unknown[]) => unknown;
}
