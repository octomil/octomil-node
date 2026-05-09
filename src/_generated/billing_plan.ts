// Auto-generated from octomil-contracts. Do not edit.

export enum BillingPlan {
  Free = "free",
  Team = "team",
  Enterprise = "enterprise",
}

export type PlanSupportLevel = "community" | "email" | "dedicated";

export interface PlanLimits {
  maxDevices: number | null;
  maxModels: number | null;
  maxEnvironments: number | null;
  storageGb: number | null;
  requestsMonthly: number | null;
  trainingRoundsMonthly: number | null;
  federatedRoundsMonthly: number | null;
  modelDownloadsMonthly: number | null;
  modelConversionsMonthly: number | null;
  dataRetentionDays: number | null;
}

export interface PlanFeatures {
  sso: boolean;
  federatedLearning: boolean;
  differentialPrivacy: boolean;
  secureAggregation: boolean;
  hipaaMode: boolean;
  advancedMonitoring: boolean;
  webhooks: boolean;
  experiments: boolean;
  rollouts: boolean;
  scim: boolean;
  siemExport: boolean;
}

export interface PlanPricing {
  monthlyCents: number | null;
  annualCents: number | null;
  overagePerDeviceCents: number | null;
}

export interface PlanConfig {
  displayName: string;
  limits: PlanLimits;
  features: PlanFeatures;
  pricing: PlanPricing;
  support: PlanSupportLevel;
}

export const PLAN_CONFIG: Record<BillingPlan, PlanConfig> = {
  [BillingPlan.Free]: {
    displayName: "Developer",
    limits: { maxDevices: 25, maxModels: 3, maxEnvironments: 1, storageGb: 5, requestsMonthly: 100000, trainingRoundsMonthly: 100, federatedRoundsMonthly: 1, modelDownloadsMonthly: 2500, modelConversionsMonthly: 20, dataRetentionDays: 7 },
    features: { sso: false, federatedLearning: true, differentialPrivacy: false, secureAggregation: false, hipaaMode: false, advancedMonitoring: false, webhooks: false, experiments: true, rollouts: true, scim: false, siemExport: false },
    pricing: { monthlyCents: 0, annualCents: 0, overagePerDeviceCents: 0 },
    support: "community",
  },
  [BillingPlan.Team]: {
    displayName: "Team",
    limits: { maxDevices: 1000, maxModels: 20, maxEnvironments: 3, storageGb: 100, requestsMonthly: 1000000, trainingRoundsMonthly: 10000, federatedRoundsMonthly: 10, modelDownloadsMonthly: 50000, modelConversionsMonthly: 500, dataRetentionDays: 90 },
    features: { sso: true, federatedLearning: true, differentialPrivacy: false, secureAggregation: false, hipaaMode: false, advancedMonitoring: true, webhooks: true, experiments: true, rollouts: true, scim: false, siemExport: false },
    pricing: { monthlyCents: 120000, annualCents: 1152000, overagePerDeviceCents: 5 },
    support: "email",
  },
  [BillingPlan.Enterprise]: {
    displayName: "Enterprise",
    limits: { maxDevices: null, maxModels: null, maxEnvironments: null, storageGb: 10000, requestsMonthly: 100000000, trainingRoundsMonthly: null, federatedRoundsMonthly: null, modelDownloadsMonthly: null, modelConversionsMonthly: null, dataRetentionDays: null },
    features: { sso: true, federatedLearning: true, differentialPrivacy: true, secureAggregation: true, hipaaMode: true, advancedMonitoring: true, webhooks: true, experiments: true, rollouts: true, scim: true, siemExport: true },
    pricing: { monthlyCents: null, annualCents: null, overagePerDeviceCents: null },
    support: "dedicated",
  },
};

export const PLAN_LIMITS: Record<BillingPlan, Record<string, number | null>> = {
  [BillingPlan.Free]: { "max_devices": 25, "max_models": 3, "max_environments": 1, "storage_gb": 5, "requests_monthly": 100000, "training_rounds_monthly": 100, "federated_rounds_monthly": 1, "model_downloads_monthly": 2500, "model_conversions_monthly": 20, "data_retention_days": 7 },
  [BillingPlan.Team]: { "max_devices": 1000, "max_models": 20, "max_environments": 3, "storage_gb": 100, "requests_monthly": 1000000, "training_rounds_monthly": 10000, "federated_rounds_monthly": 10, "model_downloads_monthly": 50000, "model_conversions_monthly": 500, "data_retention_days": 90 },
  [BillingPlan.Enterprise]: { "max_devices": null, "max_models": null, "max_environments": null, "storage_gb": 10000, "requests_monthly": 100000000, "training_rounds_monthly": null, "federated_rounds_monthly": null, "model_downloads_monthly": null, "model_conversions_monthly": null, "data_retention_days": null },
};

export const PLAN_FEATURES: Record<BillingPlan, Record<string, boolean>> = {
  [BillingPlan.Free]: { "sso": false, "federated_learning": true, "differential_privacy": false, "secure_aggregation": false, "hipaa_mode": false, "advanced_monitoring": false, "webhooks": false, "experiments": true, "rollouts": true, "scim": false, "siem_export": false },
  [BillingPlan.Team]: { "sso": true, "federated_learning": true, "differential_privacy": false, "secure_aggregation": false, "hipaa_mode": false, "advanced_monitoring": true, "webhooks": true, "experiments": true, "rollouts": true, "scim": false, "siem_export": false },
  [BillingPlan.Enterprise]: { "sso": true, "federated_learning": true, "differential_privacy": true, "secure_aggregation": true, "hipaa_mode": true, "advanced_monitoring": true, "webhooks": true, "experiments": true, "rollouts": true, "scim": true, "siem_export": true },
};
