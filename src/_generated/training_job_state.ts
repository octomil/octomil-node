// Auto-generated from octomil-contracts. Do not edit.

export enum TrainingJobState {
  New = "new",
  Eligible = "eligible",
  Queued = "queued",
  PreparingData = "preparing_data",
  WaitingForResources = "waiting_for_resources",
  Training = "training",
  Checkpointing = "checkpointing",
  Evaluating = "evaluating",
  CandidateReady = "candidate_ready",
  Staged = "staged",
  Activating = "activating",
  Active = "active",
  Completed = "completed",
  BlockedPolicy = "blocked_policy",
  Paused = "paused",
  FailedRetryable = "failed_retryable",
  FailedFatal = "failed_fatal",
  Rejected = "rejected",
  Rollback = "rollback",
  Superseded = "superseded",
}
