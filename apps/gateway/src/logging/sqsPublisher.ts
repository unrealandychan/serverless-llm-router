import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { AuditEvent } from './auditEvent';

const sqs = new SQSClient({});

/**
 * Publish an audit event to the SQS audit queue.
 * This should be called fire-and-forget from the hot path — errors are logged but not thrown.
 */
export async function publishAuditEvent(event: AuditEvent): Promise<void> {
    const queueUrl = process.env.AUDIT_QUEUE_URL;
    if (!queueUrl) {
        console.warn(JSON.stringify({ message: 'AUDIT_QUEUE_URL not set — skipping audit event', requestId: event.requestId }));
        return;
    }

    await sqs.send(
        new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(event),
        }),
    );
}
