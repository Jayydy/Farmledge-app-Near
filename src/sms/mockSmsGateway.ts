import { randomUUID } from 'node:crypto';

import type { Logger } from '../logger.js';
import type { SmsGateway, SmsMessage } from './smsGateway.js';

/**
 * SMS_GATEWAY=mock. Logs each message instead of sending it, and keeps the
 * messages in `sent` so tests can read them.
 */
export class MockSmsGateway implements SmsGateway {
  readonly provider = 'mock';
  readonly sent: SmsMessage[] = [];

  constructor(private readonly logger: Logger) {}

  send(message: SmsMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    const messageId = `mock-${randomUUID()}`;
    this.logger.info({ to: message.to, messageId, body: message.body }, 'mock SMS');
    return Promise.resolve({ messageId });
  }
}
