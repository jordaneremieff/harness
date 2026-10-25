/** Public retained Recents facts. Creator identity and actor origin are separate evidence. */
export type CreationActor = 'operator' | 'agent' | 'unknown';
export type RecentActivity = {creator: CreationActor; createdAt?: number; lastUserAt?: number; lastAnswerAt?: number; hasMessages?: boolean};
export const RECENTS_CONVERSATION_LIMIT = 200;
export type RecentConversations = {items:{conversationId:number;activity:RecentActivity}[]};
export const RECENTS_OPERATION = {request: 'recents/1.0.0', response: 'recents/1.0.0'} as const;
/** The browser creation entrypoint owns this caller spelling. Other caller identities do not identify an actor. */
export function creationActor(metadata: {ownerId?: string}): CreationActor {
  return /^operator:[a-f0-9]{64}$/u.test(metadata.ownerId ?? '') ? 'operator' : 'unknown';
}
