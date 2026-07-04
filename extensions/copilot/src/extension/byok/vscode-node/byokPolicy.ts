/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAuthenticationService } from '../../../platform/authentication/common/authentication';
import { EnterpriseManagedError, NotSignedUpError, SubscriptionExpiredError } from '../../../platform/authentication/vscode-node/copilotTokenManager';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ClientBYOKPolicySourceState, ClientBYOKPolicy, ClientBYOKPolicyEvaluation, evaluateClientBYOKPolicy, getClientBYOKPolicySourceStateFromToken, getClientBYOKPolicyFromToken } from '../common/byokProvider';

const clientBYOKEnterprisePolicyCachePrefix = 'copilot-byok-enterprise-policy';

function getClientBYOKEnterprisePolicyCacheKey(authService: IAuthenticationService): string | undefined {
	const accountId = authService.anyGitHubSession?.account.id;
	return accountId ? `${clientBYOKEnterprisePolicyCachePrefix}-${accountId}` : undefined;
}

function getCachedClientBYOKEnterprisePolicy(authService: IAuthenticationService, extensionContext?: IVSCodeExtensionContext): ClientBYOKPolicy | undefined {
	const key = getClientBYOKEnterprisePolicyCacheKey(authService);
	if (!key || !extensionContext) {
		return undefined;
	}
	return extensionContext.globalState.get<ClientBYOKPolicy>(key);
}

async function updateCachedClientBYOKEnterprisePolicy(authService: IAuthenticationService, extensionContext: IVSCodeExtensionContext | undefined, policy: ClientBYOKPolicy): Promise<void> {
	const key = getClientBYOKEnterprisePolicyCacheKey(authService);
	if (!key || !extensionContext) {
		return;
	}
	await extensionContext.globalState.update(key, policy);
}

export async function resolveClientBYOKPolicyEvaluation(
	authService: IAuthenticationService,
	extensionContext?: IVSCodeExtensionContext
): Promise<ClientBYOKPolicyEvaluation> {
	const cachedEnterprisePolicy = getCachedClientBYOKEnterprisePolicy(authService, extensionContext);
	if (!authService.anyGitHubSession) {
		return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.SignedOut, ClientBYOKPolicy.Unknown, cachedEnterprisePolicy);
	}

	try {
		const copilotToken = await authService.getCopilotToken();
		const policySourceState = getClientBYOKPolicySourceStateFromToken(copilotToken);
		const livePolicy = getClientBYOKPolicyFromToken(copilotToken);
		if (policySourceState === ClientBYOKPolicySourceState.Managed) {
			await updateCachedClientBYOKEnterprisePolicy(authService, extensionContext, livePolicy).catch(() => undefined);
		}
		return evaluateClientBYOKPolicy(policySourceState, livePolicy, cachedEnterprisePolicy);
	} catch (error) {
		if (error instanceof NotSignedUpError) {
			return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.NoCopilotEntitlement, ClientBYOKPolicy.Allow, cachedEnterprisePolicy);
		}
		if (error instanceof SubscriptionExpiredError) {
			return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.SubscriptionExpired, ClientBYOKPolicy.Allow, cachedEnterprisePolicy);
		}
		if (error instanceof EnterpriseManagedError) {
			return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.Managed, ClientBYOKPolicy.Deny, cachedEnterprisePolicy);
		}
		if (cachedEnterprisePolicy) {
			return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.ManagedPolicyUnavailable, ClientBYOKPolicy.Unknown, cachedEnterprisePolicy);
		}
		return evaluateClientBYOKPolicy(ClientBYOKPolicySourceState.UnclassifiedAuthFailure);
	}
}
