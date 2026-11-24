/**
 * Redis lock keys held by scheduled jobs while they run. Shared between the
 * jobs themselves and the admin manual-trigger endpoint so a manual run can
 * detect (and refuse to overlap) an in-flight scheduled run.
 */
export const JOB_LOCK_KEYS = {
  reconciliation: 'chainsettle:reconciliation:lock',
  'late-delivery': 'chainsettle:late-delivery:lock',
  'notification-cleanup': 'chainsettle:notification-cleanup:lock',
  'shipment-archival': 'chainsettle:shipment-archival:lock',
  'shipment-reminder': 'chainsettle:shipment-reminders:lock',
  'recurring-schedule': 'chainsettle:recurring-schedules:lock',
} as const;

export type ManuallyRunnableJob = keyof typeof JOB_LOCK_KEYS;

/**
 * Jobs an admin may trigger on demand via POST /admin/jobs/:name/run.
 * Only jobs that guard their body with a Redis lock are listed, so a manual
 * run can never overlap a scheduled one.
 */
export const MANUALLY_RUNNABLE_JOBS = Object.keys(JOB_LOCK_KEYS) as ManuallyRunnableJob[];

export function isManuallyRunnableJob(name: string): name is ManuallyRunnableJob {
  return Object.prototype.hasOwnProperty.call(JOB_LOCK_KEYS, name);
}
