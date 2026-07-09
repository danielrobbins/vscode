/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { byokKnownModelToAPIInfo, BYOKModelCapabilities, ClientBYOKPolicySourceState, ClientBYOKPolicy, evaluateClientBYOKPolicy, getClientBYOKPolicySourceStateFromToken, getClientBYOKPolicyFromToken, isClientBYOKAllowed, resolveModelInfo, resolveModelTokenLimits } from '../byokProvider';

describe('byokKnownModelToAPIInfo', () => {
	const baseCapabilities: BYOKModelCapabilities = {
		name: 'TestModel',
		maxInputTokens: 1000,
		maxOutputTokens: 100,
		toolCalling: true,
		vision: false,
	};

	it('forwards editTools into capabilities so VS Code core can populate editToolsHint', () => {
		const info = byokKnownModelToAPIInfo('TestProvider', 'm1', {
			...baseCapabilities,
			editTools: ['apply-patch'],
		});

		expect(info.capabilities).toMatchObject({
			toolCalling: true,
			imageInput: false,
			editTools: ['apply-patch'],
		});
	});

	it('forwards a restricted list of editTools verbatim', () => {
		const info = byokKnownModelToAPIInfo('TestProvider', 'm1', {
			...baseCapabilities,
			editTools: ['find-replace', 'multi-find-replace'],
		});

		expect(info.capabilities.editTools).toEqual(['find-replace', 'multi-find-replace']);
	});

	it('omits editTools when not configured', () => {
		const info = byokKnownModelToAPIInfo('TestProvider', 'm1', baseCapabilities);

		expect(info.capabilities.editTools).toBeUndefined();
	});

	it('derives maxInputTokens from contextWindow when maxInputTokens is omitted', () => {
		// The value surfaced here becomes `model.maxInputTokens`, which the custom
		// endpoint/OAI/azure providers read when building the endpoint.
		const info = byokKnownModelToAPIInfo('TestProvider', 'm1', {
			name: 'BigContextModel',
			contextWindow: 1000000,
			maxOutputTokens: 384000,
			toolCalling: true,
			vision: false,
		});

		expect(info.maxInputTokens).toBe(1000000 - 384000);
		expect(info.maxOutputTokens).toBe(384000);
	});
});

describe('resolveModelInfo', () => {
	const baseCapabilities: BYOKModelCapabilities = {
		name: 'TestModel',
		maxInputTokens: 1000,
		maxOutputTokens: 100,
		toolCalling: true,
		vision: false,
	};

	it('propagates supportsReasoningEffort and reasoningEffortFormat from BYOK capabilities into chat-endpoint inputs', () => {
		const info = resolveModelInfo('m1', 'TestProvider', undefined, {
			...baseCapabilities,
			supportsReasoningEffort: ['low', 'medium', 'high'],
			reasoningEffortFormat: 'responses',
		});

		expect(info.capabilities.supports.reasoning_effort).toEqual(['low', 'medium', 'high']);
		expect(info.reasoningEffortFormat).toBe('responses');
	});

	it('omits the reasoning effort capability when the model does not declare it', () => {
		const info = resolveModelInfo('m1', 'TestProvider', undefined, baseCapabilities);

		expect(info.capabilities.supports.reasoning_effort).toBeUndefined();
		expect(info.reasoningEffortFormat).toBeUndefined();
	});

	it('propagates configured model options into chat-endpoint inputs', () => {
		const info = resolveModelInfo('m1', 'TestProvider', undefined, {
			...baseCapabilities,
			modelOptions: {
				temperature: null,
				top_p: 0.95,
			},
		});

		expect(info.modelOptions).toEqual({
			temperature: null,
			top_p: 0.95,
		});
	});

	it('honors an explicit contextWindow as the source of truth for the context window', () => {
		// A model documented as: Context Length 1M, Max Output 384K. The user can now
		// declare the real capability directly instead of back-computing maxInputTokens.
		const info = resolveModelInfo('m1', 'TestProvider', undefined, {
			...baseCapabilities,
			contextWindow: 1000000,
			maxOutputTokens: 384000,
			maxInputTokens: undefined,
		});

		expect(info.capabilities.limits?.max_context_window_tokens).toBe(1000000);
		// The prompt budget is derived as contextWindow - maxOutputTokens.
		expect(info.capabilities.limits?.max_prompt_tokens).toBe(1000000 - 384000);
		expect(info.capabilities.limits?.max_output_tokens).toBe(384000);
	});

	it('derives the context window as maxInputTokens + maxOutputTokens when contextWindow is absent', () => {
		const info = resolveModelInfo('m1', 'TestProvider', undefined, {
			...baseCapabilities,
			maxInputTokens: 616000,
			maxOutputTokens: 384000,
		});

		expect(info.capabilities.limits?.max_context_window_tokens).toBe(616000 + 384000);
		expect(info.capabilities.limits?.max_prompt_tokens).toBe(616000);
	});

	it('falls back to a 128000 context window when no capabilities are known', () => {
		const info = resolveModelInfo('m1', 'TestProvider', undefined, undefined);

		expect(info.capabilities.limits?.max_context_window_tokens).toBe(128000);
	});
});

describe('resolveModelTokenLimits', () => {
	it('derives the window from maxInputTokens + maxOutputTokens when contextWindow is absent', () => {
		expect(resolveModelTokenLimits({ maxInputTokens: 616000, maxOutputTokens: 384000 })).toEqual({
			contextWindow: 1000000,
			maxInputTokens: 616000,
			maxOutputTokens: 384000,
		});
	});

	it('derives maxInputTokens from contextWindow when maxInputTokens is omitted', () => {
		expect(resolveModelTokenLimits({ contextWindow: 1000000, maxOutputTokens: 384000 })).toEqual({
			contextWindow: 1000000,
			maxInputTokens: 616000,
			maxOutputTokens: 384000,
		});
	});

	it('clamps maxOutputTokens so it never exceeds the context window', () => {
		expect(resolveModelTokenLimits({ contextWindow: 1000, maxOutputTokens: 8192 })).toEqual({
			contextWindow: 1000,
			maxInputTokens: 0,
			maxOutputTokens: 1000,
		});
	});

	it('clamps an explicit maxInputTokens to the remaining budget when it overflows the window', () => {
		expect(resolveModelTokenLimits({ contextWindow: 1000000, maxInputTokens: 900000, maxOutputTokens: 384000 })).toEqual({
			contextWindow: 1000000,
			maxInputTokens: 616000,
			maxOutputTokens: 384000,
		});
	});
});

describe('client BYOK policy evaluation', () => {
	function mockToken(props: { isInternal?: boolean; isIndividual?: boolean; isClientBYOKEnabled?: boolean }): Omit<CopilotToken, 'token'> {
		return {
			isInternal: props.isInternal ?? false,
			isIndividual: props.isIndividual ?? false,
			isClientBYOKEnabled: () => props.isClientBYOKEnabled ?? false,
		} as unknown as Omit<CopilotToken, 'token'>;
	}

	it.each([
		{ token: mockToken({ isInternal: true }), policySourceState: ClientBYOKPolicySourceState.Internal, policy: ClientBYOKPolicy.Allow },
		{ token: mockToken({ isIndividual: true }), policySourceState: ClientBYOKPolicySourceState.Individual, policy: ClientBYOKPolicy.Allow },
		{ token: mockToken({ isClientBYOKEnabled: true }), policySourceState: ClientBYOKPolicySourceState.Managed, policy: ClientBYOKPolicy.Allow },
		{ token: mockToken({}), policySourceState: ClientBYOKPolicySourceState.Managed, policy: ClientBYOKPolicy.Deny },
	])('classifies Copilot token policy for $policySourceState / $policy', ({ token, policySourceState, policy }) => {
		expect(getClientBYOKPolicySourceStateFromToken(token)).toBe(policySourceState);
		expect(getClientBYOKPolicyFromToken(token)).toBe(policy);
	});

	it.each([
		{
			scenario: 'signed out of GitHub',
			why: 'BYOK is local/user-owned and does not require GitHub auth',
			policySourceState: ClientBYOKPolicySourceState.SignedOut,
			livePolicy: ClientBYOKPolicy.Unknown,
			cachedPolicy: undefined,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			scenario: 'signed in without Copilot entitlement',
			why: 'BYOK should not require a paid Copilot seat',
			policySourceState: ClientBYOKPolicySourceState.NoCopilotEntitlement,
			livePolicy: ClientBYOKPolicy.Allow,
			cachedPolicy: undefined,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			scenario: 'Copilot subscription expired',
			why: 'BYOK endpoints remain independent even when Copilot access has lapsed',
			policySourceState: ClientBYOKPolicySourceState.SubscriptionExpired,
			livePolicy: ClientBYOKPolicy.Allow,
			cachedPolicy: undefined,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			scenario: 'managed account with live BYOK allow policy',
			why: 'live enterprise policy takes precedence over stale cached policy',
			policySourceState: ClientBYOKPolicySourceState.Managed,
			livePolicy: ClientBYOKPolicy.Allow,
			cachedPolicy: ClientBYOKPolicy.Deny,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			scenario: 'managed account with live BYOK deny policy',
			why: 'explicit enterprise policy must be respected',
			policySourceState: ClientBYOKPolicySourceState.Managed,
			livePolicy: ClientBYOKPolicy.Deny,
			cachedPolicy: ClientBYOKPolicy.Allow,
			expectedPolicy: ClientBYOKPolicy.Deny,
		},
		{
			scenario: 'managed policy unavailable with cached allow policy',
			why: 'air-gapped enterprise users should retain last known allowed BYOK policy',
			policySourceState: ClientBYOKPolicySourceState.ManagedPolicyUnavailable,
			livePolicy: ClientBYOKPolicy.Unknown,
			cachedPolicy: ClientBYOKPolicy.Allow,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
		{
			scenario: 'managed policy unavailable with cached deny policy',
			why: 'air-gapped enterprise users should retain last known denied BYOK policy',
			policySourceState: ClientBYOKPolicySourceState.ManagedPolicyUnavailable,
			livePolicy: ClientBYOKPolicy.Unknown,
			cachedPolicy: ClientBYOKPolicy.Deny,
			expectedPolicy: ClientBYOKPolicy.Deny,
		},
		{
			scenario: 'managed policy unavailable with no cached policy',
			why: 'enterprise policy enforcement should fail closed when policy is unknown',
			policySourceState: ClientBYOKPolicySourceState.ManagedPolicyUnavailable,
			livePolicy: ClientBYOKPolicy.Unknown,
			cachedPolicy: undefined,
			expectedPolicy: ClientBYOKPolicy.Deny,
		},
		{
			scenario: 'unclassified auth failure without enterprise policy signal',
			why: 'do not block BYOK for ordinary users solely because Copilot auth failed',
			policySourceState: ClientBYOKPolicySourceState.UnclassifiedAuthFailure,
			livePolicy: ClientBYOKPolicy.Unknown,
			cachedPolicy: undefined,
			expectedPolicy: ClientBYOKPolicy.Allow,
		},
	])('$scenario: $why', ({ policySourceState, livePolicy, cachedPolicy, expectedPolicy }) => {
		const evaluation = evaluateClientBYOKPolicy(policySourceState, livePolicy, cachedPolicy);

		expect(evaluation).toEqual({
			policySourceState,
			livePolicy,
			cachedEnterprisePolicy: cachedPolicy,
			finalPolicy: expectedPolicy,
		});
		expect(isClientBYOKAllowed(evaluation)).toBe(expectedPolicy === ClientBYOKPolicy.Allow);
	});
});
