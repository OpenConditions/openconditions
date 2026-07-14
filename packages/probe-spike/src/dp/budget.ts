/**
 * Per-privacy-unit budget ledger. The privacy unit is "one admitted device-key
 * epoch" (the admitted keyId + epoch), modelled here as an opaque `privacyUnitId`.
 * The glue tracks cumulative (ε, δ) spend PER UNIT across every segment /
 * resolution / window it can affect — not merely per segment — and fails closed
 * when a unit's rolling spend would exceed its budget.
 *
 * The ledger uses CONSERVATIVE basic sequential composition (Σεᵢ, Σδᵢ) as the
 * FLOOR. This is deliberately the loosest bound: the real DP library's advanced /
 * RDP / zCDP accounting gives strictly tighter budgets. That tighter math is the
 * library's responsibility and is NOT implemented here — hand-rolling an RDP or
 * zCDP accountant is exactly the forbidden move. The floor is safe precisely
 * because it over-charges.
 */

/** A unit's cumulative spend under basic sequential composition. */
export interface UnitSpend {
  epsilon: number;
  delta: number;
}

/** The per-unit budget ceiling. */
export interface UnitBudget {
  epsilon: number;
  delta: number;
}

/**
 * Mutable per-unit spend ledger. Composition is Σ (basic sequential); this is the
 * conservative floor, not the tight bound the library would compute.
 */
export class BudgetLedger {
  private readonly spend = new Map<string, UnitSpend>();

  constructor(private readonly budget: UnitBudget) {}

  /** Current cumulative spend for a unit (zero if never charged). */
  spent(privacyUnitId: string): UnitSpend {
    return this.spend.get(privacyUnitId) ?? { epsilon: 0, delta: 0 };
  }

  /** Remaining headroom for a unit under its budget. */
  remaining(privacyUnitId: string): UnitSpend {
    const s = this.spent(privacyUnitId);
    return { epsilon: this.budget.epsilon - s.epsilon, delta: this.budget.delta - s.delta };
  }

  /**
   * Whether charging `cost` to a unit stays within budget. Uses Σ composition:
   * the unit can proceed only if BOTH the ε and δ floors remain within the
   * ceiling. Fail-closed callers drop the unit when this returns false.
   */
  canAfford(privacyUnitId: string, cost: UnitSpend): boolean {
    const s = this.spent(privacyUnitId);
    return (
      s.epsilon + cost.epsilon <= this.budget.epsilon && s.delta + cost.delta <= this.budget.delta
    );
  }

  /** Commits `cost` to a unit's cumulative spend (Σ composition). */
  charge(privacyUnitId: string, cost: UnitSpend): void {
    const s = this.spent(privacyUnitId);
    this.spend.set(privacyUnitId, {
      epsilon: s.epsilon + cost.epsilon,
      delta: s.delta + cost.delta,
    });
  }

  /** Snapshot of the whole ledger (test/audit visibility). */
  snapshot(): Record<string, UnitSpend> {
    return Object.fromEntries([...this.spend.entries()].map(([k, v]) => [k, { ...v }]));
  }
}
