import { units } from './funding-contract';

export interface PhoenixConsumerContext {
  kind: 'signal' | 'lab' | 'marketplace'; initialFundingBaseUnits: string; sourcePublishedBotId?: string;
}
export function validatePhoenixConsumer(context: PhoenixConsumerContext) {
  if (!['signal', 'lab', 'marketplace'].includes(context.kind) || units(context.initialFundingBaseUnits) === 0n
    || (context.kind === 'marketplace' ? !context.sourcePublishedBotId : context.sourcePublishedBotId !== undefined)) {
    throw new Error('Invalid Phoenix consumer binding');
  }
}
