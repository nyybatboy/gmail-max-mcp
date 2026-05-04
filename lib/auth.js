import { google } from 'googleapis';

export const SCOPES = ['https://mail.google.com/'];

let _client = null;

export async function getAuthClient() {
  if (_client) return _client;
  try {
    const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
    _client = await auth.getClient();
    return _client;
  } catch (err) {
    throw mapAuthError(err);
  }
}

export function mapAuthError(err) {
  const msg = err?.message || '';
  if (
    msg.includes('Could not load the default credentials') ||
    msg.includes('application_default_credentials.json') ||
    msg.includes('Application Default Credentials')
  ) {
    return enrich(
      err,
      'ADC not configured.\n' +
        'Fix:  gcloud auth application-default login --scopes=https://mail.google.com/\n' +
        'If gcloud is not installed:  brew install --cask gcloud-cli'
    );
  }
  return err;
}

export function mapApiError(err) {
  const status = err?.code || err?.response?.status;
  const reason = err?.errors?.[0]?.reason || err?.response?.data?.error?.status;
  const detail =
    err?.response?.data?.error?.message ||
    err?.errors?.[0]?.message ||
    err?.message ||
    '';

  if (status === 403 && /not been used|SERVICE_DISABLED|disabled/i.test(detail)) {
    return enrich(
      err,
      'Gmail API is not enabled on your gcloud project.\n' +
        'Fix:  gcloud services enable gmail.googleapis.com'
    );
  }
  if (
    status === 403 &&
    /quota project|userProject|user_project|billing.*disabled/i.test(detail)
  ) {
    return enrich(
      err,
      'No quota project set on your ADC.\n' +
        'Fix:  gcloud auth application-default set-quota-project $(gcloud config get-value project)'
    );
  }
  if (
    status === 403 &&
    /insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(
      detail + ' ' + (reason || '')
    )
  ) {
    return enrich(
      err,
      'ADC token does not include the required Gmail scope.\n' +
        'Fix:  gcloud auth application-default login --scopes=https://mail.google.com/'
    );
  }
  if (
    status === 401 ||
    reason === 'UNAUTHENTICATED' ||
    /invalid_grant|invalid_token|token has been expired or revoked/i.test(detail)
  ) {
    return enrich(
      err,
      'ADC token rejected (revoked, expired, or scope mismatch).\n' +
        'Fix:  gcloud auth application-default login --scopes=https://mail.google.com/'
    );
  }
  return err;
}

function enrich(err, hint) {
  const wrapped = new Error(`${err.message || 'Gmail API error'}\n\n${hint}`);
  wrapped.code = err.code;
  wrapped.cause = err;
  wrapped.userActionable = true;
  wrapped.originalErrors = err.errors || err.response?.data || null;
  return wrapped;
}

// For tests / diagnostics — does not consume credentials.
export function adcPath() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? process.env.GOOGLE_APPLICATION_CREDENTIALS
    : `${home}/.config/gcloud/application_default_credentials.json`;
}
