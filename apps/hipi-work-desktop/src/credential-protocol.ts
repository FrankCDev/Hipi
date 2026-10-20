export {
	type CredentialProvider,
	credentialProvider,
	credentialSecret,
	credentialState,
	MAX_CREDENTIAL_PROVIDERS,
	parseCredentialRequest as credentialRequest,
} from "@hipi/work-runtime/credentials";

export const CREDENTIAL_CHANNEL = "hipi-work:credentials:v1";
