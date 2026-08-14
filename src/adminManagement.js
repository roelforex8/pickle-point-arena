export const administratorRemovalConfirmation = 'REMOVE';

export function canConfirmAdministratorRemoval(value, submitting = false) {
  return !submitting && value === administratorRemovalConfirmation;
}

export function administratorStatusLabel(status) {
  if (status === 'removed') return 'Removed';
  if (status === 'disabled') return 'Access disabled';
  return 'Active';
}
