import { phoenixDisabledCreation, type PhoenixProvisioner, type ProvisioningResult } from './provisioner';
import { phoenixCreationId, type PhoenixCreationRequest } from './provisioning-store';
import type { PhoenixFundingService } from './funding-service';
import type { PhoenixOperationStore, StoredPhoenixOperation } from './operation-store';
import type { FundingIntent } from './funding-contract';
import { validatePhoenixConsumer, type PhoenixConsumerContext } from './consumer-contract';

export function phoenixConsumerDisabled(requestId: unknown) {
  return { ...phoenixDisabledCreation(requestId), activeProtocol: 'phoenix', fundingManagedBy: 'phoenix', funded: false,
    fundingWarning: 'Phoenix consumer provisioning and funding are not enabled.' };
}

/** All three consumers share U03 allocation and U04's immutable funding journal.
 * The quote builder is trusted server code; clients never supply signing intents.
 * There is no production instance until the reviewed registration/funding pins exist. */
export class PhoenixConsumerService {
  constructor(private readonly provisioning: Pick<PhoenixProvisioner, 'create'>,
    private readonly funding: Pick<PhoenixFundingService, 'create' | 'resume'>,
    private readonly operations: Pick<PhoenixOperationStore, 'fundingHistory'>,
    private readonly build: (registration: ProvisioningResult, request: PhoenixCreationRequest & { consumer: PhoenixConsumerContext },
      leg: 'wallet_funding' | 'deposit', parent?: StoredPhoenixOperation) => Promise<FundingIntent>,
    private readonly enabled = () => false) {}

  async create(input: PhoenixCreationRequest & { consumer: PhoenixConsumerContext }) {
    const request = structuredClone(input);
    validatePhoenixConsumer(request.consumer);
    if (!this.enabled()) return phoenixConsumerDisabled(request.requestId);
    const registration = await this.provisioning.create(request);
    const handoff = { ...registration, id: registration.botId, activeProtocol: 'phoenix' as const,
      fundingManagedBy: 'phoenix' as const, funded: false };
    if (registration.status !== 'completed') return { ...handoff, fundingWarning: registration.message };
    if (!registration.botId || !registration.identity
      || registration.botId !== phoenixCreationId(request.ownerWallet, request.requestId)) throw new Error('Consumer registration identity mismatch');
    let parent: StoredPhoenixOperation | undefined;
    try {
      for (const leg of ['wallet_funding', 'deposit'] as const) {
        const requestKey = `consumer:${leg}:${registration.botId}`;
        const history = await this.operations.fundingHistory(registration.botId, request.ownerWallet);
        const existing = history.find(row => row.request_key === requestKey);
        let operation: StoredPhoenixOperation;
        if (existing) {
          // Reuse the originally quoted terms even after quote expiry or restart.
          this.bind(existing.intent as FundingIntent, request, registration, leg, requestKey, parent);
          operation = await this.funding.resume(registration.botId, request.ownerWallet, existing.id);
        } else {
          const intent = await this.build(registration, request, leg, parent);
          this.bind(intent, request, registration, leg, requestKey, parent);
          operation = await this.funding.create(intent);
        }
        if (operation.state !== 'completed') return { ...handoff, fundingOperationId: operation.id,
          fundingWarning: 'Funding is pending or needs recovery. Resume this creation request; do not deposit again.' };
        parent = operation;
      }
      return { ...handoff, funded: true };
    } catch {
      return { ...handoff, fundingWarning: 'Funding could not be confirmed. The bot and funding records are retained; resume this request.' };
    }
  }
  private bind(intent: FundingIntent, request: PhoenixCreationRequest & { consumer: PhoenixConsumerContext },
    registration: ProvisioningResult, leg: 'wallet_funding' | 'deposit', requestKey: string, parent?: StoredPhoenixOperation) {
    if (intent.botId !== registration.botId || intent.ownerWallet !== request.ownerWallet || intent.requestKey !== requestKey
      || intent.identity.authorityWalletAddress !== registration.identity!.authorityWalletAddress
      || intent.identity.traderAccountAddress !== registration.identity!.traderAccountAddress
      || intent.amountBaseUnits !== request.consumer.initialFundingBaseUnits || intent.feeBaseUnits !== '0'
      || intent.funding.leg !== leg || intent.funding.parentOperationId !== parent?.id) throw new Error('Consumer funding binding mismatch');
  }
}
