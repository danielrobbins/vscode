/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { EnterpriseManagedError, NotSignedUpError, SubscriptionExpiredError } from '../../../../platform/authentication/vscode-node/copilotTokenManager';
import { IVSCodeExtensionContext } from '../../../../platform/extContext/common/extensionContext';
import { ClientBYOKPolicySourceState, ClientBYOKPolicy } from '../../common/byokProvider';
import { resolveClientBYOKPolicyEvaluation } from '../byokPolicy';

function mockToken(props: { isInternal?: boolean; isIndividual?: boolean; isClientBYOKEnabled?: boolean }): CopilotToken {
	return {
		isInternal: props.isInternal ?? false,
		isIndividual: props.isIndividual ?? false,
		isClientBYOKEnabled: () => props.isClientBYOKEnabled ?? false,
	} as unknown as CopilotToken;
}

function createAuthService(options: { signedIn?: boolean; token?: CopilotToken; error?: Error }): IAuthenticationService {
	return {
		anyGitHubSession: options.signedIn === false ? undefined : {
			account: { id: 'acct-1', label: 'test-user' },
			accessToken: 'gh-token',
			id: 'session-1',
			scopes: [],
		},
		getCopilotToken: vi.fn(async () => {
			if (options.error) {
				throw options.error;
			}
			return options.token ?? mockToken({});
		}),
	} as unknown as IAuthenticationService;
}

function createExtensionContext(initialPolicy?: ClientBYOKPolicy): IVSCodeExtensionContext {
	const state = new Map<string, unknown>();
	if (initialPolicy) {
		state.set('copilot-byok-enterprise-policy-acct-1', initialPolicy);
	}
	return {
		globalState: {
			get: vi.fn((key: string, defaultValue?: unknown) => state.has(key) ? state.get(key) : defaultValue),
			update: vi.fn(async (key: string, value: unknown) => {
				state.set(key, value);
			}),
		},
	} as unknown as IVSCodeExtensionContext;
}

function createFailingCacheExtensionContext(): IVSCodeExtensionContext {
	return {
		globalState: {
			get: vi.fn(() => undefined),
			update: vi.fn(async () => {
				throw new Error('cache unavailable');
			}),
		},
	} as unknown as IVSCodeExtensionContext;
}

describe('resolveClientBYOKPolicyEvaluation', () => {
	it('allows signed-out users without resolving a Copilot token', async () => {
		const authService = createAuthService({ signedIn: false });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createExtensionContext());

		expect(authService.getCopilotToken).not.toHaveBeenCalled();
		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.SignedOut);
		expect(evaluation.finalPolicy).toBe(ClientBYOKPolicy.Allow);
	});

	it.each([
		{
			name: 'signed-in users without Copilot entitlement',
			error: new NotSignedUpError('not signed up'),
			policySourceState: ClientBYOKPolicySourceState.NoCopilotEntitlement,
		},
		{
			name: 'signed-in users whose Copilot subscription expired',
			error: new SubscriptionExpiredError('subscription expired'),
			policySourceState: ClientBYOKPolicySourceState.SubscriptionExpired,
		},
	])('allows $name', async ({ error, policySourceState }) => {
		const authService = createAuthService({ error });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createExtensionContext());

		expect(evaluation.policySourceState).toBe(policySourceState);
		expect(evaluation.finalPolicy).toBe(ClientBYOKPolicy.Allow);
	});

	it('denies explicit enterprise-managed auth failures', async () => {
		const authService = createAuthService({ error: new EnterpriseManagedError('enterprise managed') });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createExtensionContext(ClientBYOKPolicy.Allow));

		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.Managed);
		expect(evaluation.livePolicy).toBe(ClientBYOKPolicy.Deny);
		expect(evaluation.finalPolicy).toBe(ClientBYOKPolicy.Deny);
	});

	it.each([
		{
			name: 'allows',
			token: mockToken({ isClientBYOKEnabled: true }),
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			name: 'denies',
			token: mockToken({}),
			expectedPolicy: ClientBYOKPolicy.Deny,
		},
	])('$name managed users from live token policy and caches it', async ({ token, expectedPolicy }) => {
		const authService = createAuthService({ token });
		const extensionContext = createExtensionContext();

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, extensionContext);

		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.Managed);
		expect(evaluation.livePolicy).toBe(expectedPolicy);
		expect(evaluation.finalPolicy).toBe(expectedPolicy);
		expect(extensionContext.globalState.update).toHaveBeenCalledWith('copilot-byok-enterprise-policy-acct-1', expectedPolicy);
	});

	it('keeps the live policy decision if caching the managed policy fails', async () => {
		const authService = createAuthService({ token: mockToken({ isClientBYOKEnabled: true }) });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createFailingCacheExtensionContext());

		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.Managed);
		expect(evaluation.livePolicy).toBe(ClientBYOKPolicy.Allow);
		expect(evaluation.finalPolicy).toBe(ClientBYOKPolicy.Allow);
	});

	it.each([
		{
			name: 'allows when cached policy allows',
			cachedPolicy: ClientBYOKPolicy.Allow,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			name: 'denies when cached policy denies',
			cachedPolicy: ClientBYOKPolicy.Deny,
			expectedPolicy: ClientBYOKPolicy.Deny,
		},
	])('$name after enterprise policy becomes unavailable', async ({ cachedPolicy, expectedPolicy }) => {
		const authService = createAuthService({ error: new Error('network unavailable') });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createExtensionContext(cachedPolicy));

		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.ManagedPolicyUnavailable);
		expect(evaluation.cachedEnterprisePolicy).toBe(cachedPolicy);
		expect(evaluation.finalPolicy).toBe(expectedPolicy);
	});

	it('allows unclassified auth failures when there is no enterprise policy signal', async () => {
		const authService = createAuthService({ error: new Error('network unavailable') });

		const evaluation = await resolveClientBYOKPolicyEvaluation(authService, createExtensionContext());

		expect(evaluation.policySourceState).toBe(ClientBYOKPolicySourceState.UnclassifiedAuthFailure);
		expect(evaluation.finalPolicy).toBe(ClientBYOKPolicy.Allow);
	});
});
