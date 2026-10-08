import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { MembershipLifecycleRepositoryError, transferOwner as transfer, removeMember as remove, leaveHousehold as leave, listMembers as list } from "./membership-lifecycle.repository";

export { MembershipLifecycleRepositoryError, SupabaseAuthError };
export class MembershipLifecycleValidationError extends Error { constructor() { super("Invalid membership input."); this.name = "MembershipLifecycleValidationError"; } }
export class MembershipLifecycleConflictError extends Error { constructor() { super("Membership operation conflicts with the current household state."); this.name = "MembershipLifecycleConflictError"; } }
export class MembershipLifecycleForbiddenError extends Error { constructor() { super("The authenticated user is not allowed to manage this household."); this.name = "MembershipLifecycleForbiddenError"; } }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function auth() { const u=await getAuthenticatedAuthUser(); return u.id; }
function check(...ids:string[]) { if(ids.some(x=>!UUID.test(x))) throw new MembershipLifecycleValidationError(); }
function map(error: unknown): never { if(error instanceof MembershipLifecycleRepositoryError && ["42501","P0002"].includes(error.code??"")) throw new MembershipLifecycleForbiddenError(); if(error instanceof MembershipLifecycleRepositoryError && ["P0003","P0004"].includes(error.code??"")) throw new MembershipLifecycleConflictError(); throw error; }
export async function transferOwnership(householdId:string,targetMemberId:string,idempotencyKey:string) { check(householdId,targetMemberId,idempotencyKey); try{return await transfer(await auth(),householdId,targetMemberId,idempotencyKey);}catch(e){map(e);} }
export async function removeHouseholdMember(householdId:string,targetMemberId:string) { check(householdId,targetMemberId); try{return await remove(await auth(),householdId,targetMemberId);}catch(e){map(e);} }
export async function leaveMembership(householdId:string) { check(householdId); try{return await leave(await auth(),householdId);}catch(e){map(e);} }
export async function listHouseholdMembersWithLifecycle(householdId:string, currentUserId?: string) { check(householdId); const rows = await list(householdId); return rows.map((row) => ({ ...row, isCurrentUser: currentUserId ? row.user_id === currentUserId : false })); }
