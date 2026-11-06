/** Sends one SMS. Implementations: MockSmsGateway now; a real provider later. */
export interface SmsGateway {
  readonly provider: string;
  /** Resolves with the provider's message id; rejects if the provider refused it. */
  send(message: SmsMessage): Promise<{ messageId: string }>;
}

export interface SmsMessage {
  /** E.164. */
  readonly to: string;
  readonly body: string;
}
