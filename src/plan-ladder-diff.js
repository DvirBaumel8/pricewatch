/**
 * Plan-ladder diff engine + noise gate.
 *
 * diffPlanLadders(oldPlans, newPlans) → { changes[], hasSignal }
 *
 * Signal = price/plan/seat move only.
 * Noise  = banner/copy/layout-only changes → hasSignal=false, no email.
 *
 * Each change: { plan, field, old, new, type: "price_change"|"plan_added"|"plan_removed"|"unit_change" }
 */
"use strict";

function normalizePlan(p) {
  return {
    plan: (p.plan || "").trim(),
    price: p.price,
    currency: (p.currency || "USD").toUpperCase(),
    unit: p.unit || null,
    billing: (p.billing || "monthly").toLowerCase(),
  };
}

function diffPlanLadders(oldPlans, newPlans) {
  if (!oldPlans || !newPlans) {
    return { changes: [], hasSignal: false };
  }

  const oldMap = new Map();
  for (const p of oldPlans) {
    const n = normalizePlan(p);
    oldMap.set(n.plan.toLowerCase(), n);
  }

  const newMap = new Map();
  for (const p of newPlans) {
    const n = normalizePlan(p);
    newMap.set(n.plan.toLowerCase(), n);
  }

  const changes = [];

  for (const [key, newPlan] of newMap) {
    if (!oldMap.has(key)) {
      changes.push({
        plan: newPlan.plan,
        field: "plan",
        old: null,
        new: newPlan.plan,
        type: "plan_added",
        newPrice: newPlan.price,
        newCurrency: newPlan.currency,
        newUnit: newPlan.unit,
        newBilling: newPlan.billing,
      });
      continue;
    }

    const oldPlan = oldMap.get(key);

    if (oldPlan.price !== newPlan.price) {
      changes.push({
        plan: newPlan.plan,
        field: "price",
        old: oldPlan.price,
        new: newPlan.price,
        type: "price_change",
        currency: newPlan.currency,
        billing: newPlan.billing,
      });
    }

    if (oldPlan.currency !== newPlan.currency) {
      changes.push({
        plan: newPlan.plan,
        field: "currency",
        old: oldPlan.currency,
        new: newPlan.currency,
        type: "price_change",
      });
    }

    if (oldPlan.unit !== newPlan.unit) {
      changes.push({
        plan: newPlan.plan,
        field: "unit",
        old: oldPlan.unit,
        new: newPlan.unit,
        type: "unit_change",
      });
    }

    if (oldPlan.billing !== newPlan.billing) {
      changes.push({
        plan: newPlan.plan,
        field: "billing",
        old: oldPlan.billing,
        new: newPlan.billing,
        type: "price_change",
      });
    }
  }

  for (const [key, oldPlan] of oldMap) {
    if (!newMap.has(key)) {
      changes.push({
        plan: oldPlan.plan,
        field: "plan",
        old: oldPlan.plan,
        new: null,
        type: "plan_removed",
        oldPrice: oldPlan.price,
        oldCurrency: oldPlan.currency,
        oldUnit: oldPlan.unit,
        oldBilling: oldPlan.billing,
      });
    }
  }

  const signalTypes = new Set(["price_change", "plan_added", "plan_removed", "unit_change"]);
  const hasSignal = changes.some((c) => signalTypes.has(c.type));

  return { changes, hasSignal };
}

module.exports = { diffPlanLadders, normalizePlan };
