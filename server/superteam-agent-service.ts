import { db } from "./db";
import { superteamAgents, superteamSubmissions } from "@shared/schema";
import { eq } from "drizzle-orm";

const BASE_URL = "https://superteam.fun";

interface AgentRegistrationResponse {
  apiKey: string;
  claimCode: string;
  agentId: string;
  username: string;
}

interface ListingDetails {
  id: string;
  slug: string;
  title: string;
  description: string;
  type: string;
  status: string;
  deadline: string;
  token: string;
  rewardAmount: number;
  compensationType: string;
  requirements: string;
  eligibilityQuestions: any[];
  pocId: string;
  skills: string[];
  [key: string]: any;
}

interface SubmissionResponse {
  id: string;
  listingId: string;
  status: string;
  [key: string]: any;
}

export class SuperteamAgentService {
  private getActiveAgent() {
    return db.select().from(superteamAgents).where(eq(superteamAgents.status, "active")).limit(1);
  }

  async registerAgent(name: string): Promise<AgentRegistrationResponse> {
    console.log(`[Superteam] Registering agent: ${name}`);

    const response = await fetch(`${BASE_URL}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Agent registration failed (${response.status}): ${errorText}`);
    }

    const data = await response.json() as AgentRegistrationResponse;

    await db.insert(superteamAgents).values({
      agentName: name,
      agentId: data.agentId,
      apiKey: data.apiKey,
      claimCode: data.claimCode,
      username: data.username,
      status: "active",
    });

    console.log(`[Superteam] Agent registered: id=${data.agentId}, username=${data.username}`);
    return data;
  }

  async getAgent() {
    const agents = await this.getActiveAgent();
    if (agents.length === 0) return null;
    return agents[0];
  }

  async listLiveListings(take = 20, deadline?: string) {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    let url = `${BASE_URL}/api/agents/listings/live?take=${take}`;
    if (deadline) url += `&deadline=${deadline}`;

    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${agent.apiKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch listings (${response.status}): ${errorText}`);
    }

    return await response.json();
  }

  async getListingDetails(slug: string) {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    const response = await fetch(`${BASE_URL}/api/agents/listings/details/${slug}`, {
      headers: { "Authorization": `Bearer ${agent.apiKey}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch listing details (${response.status}): ${errorText}`);
    }

    return await response.json() as ListingDetails;
  }

  async submitToListing(params: {
    listingId: string;
    listingSlug?: string;
    listingTitle?: string;
    link: string;
    otherInfo: string;
    tweet?: string;
    telegram?: string;
    eligibilityAnswers?: any[];
    ask?: number | null;
  }): Promise<SubmissionResponse> {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    console.log(`[Superteam] Submitting to listing ${params.listingId}`);

    const response = await fetch(`${BASE_URL}/api/agents/submissions/create`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${agent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        listingId: params.listingId,
        link: params.link,
        otherInfo: params.otherInfo,
        tweet: params.tweet || "",
        telegram: params.telegram || "",
        eligibilityAnswers: params.eligibilityAnswers || [],
        ask: params.ask ?? null,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Submission failed (${response.status}): ${errorText}`);
    }

    const result = await response.json() as SubmissionResponse;

    await db.insert(superteamSubmissions).values({
      agentId: agent.agentId!,
      listingId: params.listingId,
      listingSlug: params.listingSlug || null,
      listingTitle: params.listingTitle || null,
      link: params.link,
      otherInfo: params.otherInfo,
      tweet: params.tweet || null,
      telegram: params.telegram || null,
      status: "submitted",
    });

    console.log(`[Superteam] Submission created for listing ${params.listingId}`);
    return result;
  }

  async updateSubmission(params: {
    listingId: string;
    link: string;
    otherInfo: string;
    tweet?: string;
    telegram?: string;
    eligibilityAnswers?: any[];
    ask?: number | null;
  }) {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    console.log(`[Superteam] Updating submission for listing ${params.listingId}`);

    const response = await fetch(`${BASE_URL}/api/agents/submissions/update`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${agent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        listingId: params.listingId,
        link: params.link,
        otherInfo: params.otherInfo,
        tweet: params.tweet || "",
        telegram: params.telegram || "",
        eligibilityAnswers: params.eligibilityAnswers || [],
        ask: params.ask ?? null,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Submission update failed (${response.status}): ${errorText}`);
    }

    const result = await response.json();

    await db.update(superteamSubmissions)
      .set({
        link: params.link,
        otherInfo: params.otherInfo,
        tweet: params.tweet || null,
        telegram: params.telegram || null,
        status: "updated",
        updatedAt: new Date(),
      })
      .where(eq(superteamSubmissions.listingId, params.listingId));

    console.log(`[Superteam] Submission updated for listing ${params.listingId}`);
    return result;
  }

  async getComments(listingId: string, skip = 0, take = 20) {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    const response = await fetch(
      `${BASE_URL}/api/agents/comments/${listingId}?skip=${skip}&take=${take}`,
      { headers: { "Authorization": `Bearer ${agent.apiKey}` } }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch comments (${response.status}): ${errorText}`);
    }

    return await response.json();
  }

  async postComment(params: {
    listingId: string;
    message: string;
    pocId?: string;
    replyToId?: string;
    replyToUserId?: string;
  }) {
    const agent = await this.getAgent();
    if (!agent?.apiKey) throw new Error("No active agent. Register an agent first.");

    const response = await fetch(`${BASE_URL}/api/agents/comments/create`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${agent.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        refType: "BOUNTY",
        refId: params.listingId,
        message: params.message,
        pocId: params.pocId || undefined,
        replyToId: params.replyToId || undefined,
        replyToUserId: params.replyToUserId || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Comment failed (${response.status}): ${errorText}`);
    }

    return await response.json();
  }

  async getSubmissions() {
    return db.select().from(superteamSubmissions).orderBy(superteamSubmissions.submittedAt);
  }

  async getAllAgents() {
    return db.select().from(superteamAgents).orderBy(superteamAgents.createdAt);
  }
}

export const superteamAgentService = new SuperteamAgentService();
