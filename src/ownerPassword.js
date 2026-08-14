export function ownerPasswordErrorMessage(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();

  if (code === 'invalid_credentials' || message.includes('current password')) {
    return 'The current password is incorrect.';
  }
  if (code === 'weak_password' || message.includes('weak password')) {
    return 'Choose a stronger new password that meets all password requirements.';
  }
  if (code === 'same_password' || message.includes('different from the old password')) {
    return 'Choose a new password that is different from the current password.';
  }
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') {
    return 'Too many password attempts were made. Wait a few minutes and try again.';
  }
  if (code === 'reauthentication_needed') {
    return 'Your session needs additional verification. Sign out, sign in again, and retry the password change.';
  }
  return 'The password could not be changed. Check your connection and try again.';
}

export async function changeOwnerPassword(auth, { currentPassword, newPassword }) {
  let result;
  try {
    result = await auth.updateUser({
      password: newPassword,
      current_password: currentPassword,
    });
  } catch {
    throw new Error(ownerPasswordErrorMessage());
  }

  if (result.error) throw new Error(ownerPasswordErrorMessage(result.error));
}
