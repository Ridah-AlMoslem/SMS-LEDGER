from dataclasses import dataclass

@dataclass
class Txn:
    acct: str; amount: float; direction: str; type: str
    internal: bool = False; interest: float = 0.0; income_class: str = ""

ACCOUNTS = {"checking":"asset","savings":"asset","card":"liability","loan":"liability"}
OPENING  = {"checking":10000.0,"savings":5000.0,"card":0.0,"loan":50000.0}

# One salary cycle (25th -> 24th):
#   salary 12000; 800 groceries on card; card paid in full;
#   loan payment 2000 (300 interest / 1700 principal);
#   1000 + 3000 moved to savings; savings pays 45 profit
T = [
 Txn("checking",12000,"credit","income",income_class="earned"),
 Txn("card",800,"debit","purchase"),
 Txn("checking",800,"debit","card_payment",internal=True),
 Txn("card",800,"credit","card_payment",internal=True),
 Txn("checking",2000,"debit","loan_payment",interest=300),
 Txn("loan",1700,"credit","loan_payment"),
 Txn("checking",1000,"debit","transfer",internal=True),
 Txn("savings",1000,"credit","transfer",internal=True),
 Txn("checking",3000,"debit","transfer",internal=True),      # savings deposit
 Txn("savings",3000,"credit","transfer",internal=True),
 Txn("savings",45,"credit","income",income_class="passive"), # monthly profit payout
]

bal = dict(OPENING)
for t in T:
    sign = 1 if t.direction == "credit" else -1
    if ACCOUNTS[t.acct] == "liability": sign = -sign   # debit on a liability raises debt
    bal[t.acct] += sign * t.amount

expense = sum(t.amount for t in T
              if t.direction == "debit" and not t.internal
              and t.type not in ("card_payment","loan_payment")) \
        + sum(t.interest for t in T)
earned  = sum(t.amount for t in T if t.income_class == "earned")
passive = sum(t.amount for t in T if t.income_class == "passive")
income  = earned + passive

assets = sum(v for k,v in bal.items() if ACCOUNTS[k] == "asset")
liabs  = sum(v for k,v in bal.items() if ACCOUNTS[k] == "liability")
open_nw = sum(v for k,v in OPENING.items() if ACCOUNTS[k]=="asset") \
        - sum(v for k,v in OPENING.items() if ACCOUNTS[k]=="liability")

print("balances        ", {k: round(v,2) for k,v in bal.items()})
print(f"income           {income}  (earned {earned} + passive {passive})")
print(f"expense          {expense}  (800 groceries + 300 loan interest)")
print(f"net worth        {assets-liabs}   (opening {open_nw})")
print(f"savings rate     {(income-expense)/income*100:.1f}% incl. profit | "
      f"{(earned-expense)/earned*100:.1f}% earned-only")
print(f"passive covers   {passive/expense*100:.1f}% of expenses")

# --- invariants ---
assert sum((1 if t.direction=="credit" else -1)*t.amount for t in T if t.internal) == 0, \
    "internal transfers must net to zero"
assert expense == 800+300, f"expense double-count: {expense}"
assert bal["savings"] == 5000+1000+3000+45, "savings deposits + profit must accrue"
delta_nw = (assets-liabs) - open_nw
print(f"\nnet worth change {delta_nw} == income - expense {income-expense}")
assert abs(delta_nw - (income-expense)) < 0.01, \
    "MASTER INVARIANT: net worth must reconcile to income - expense"

naive = sum(t.amount for t in T if t.direction=="debit")
print(f"naive (buggy)    {naive} -> overstates spending by {naive/expense:.2f}x")
print("\nALL INVARIANTS PASS")

# ---------------------------------------------------------------------------
# Scenario B: no routine. Savings is drawn DOWN this cycle to cover overspend,
# and a variable profit still lands in the same savings account.
# ---------------------------------------------------------------------------
print("\n" + "="*60)
print("Scenario B: savings withdrawal funds overspending")
OPEN_B = {"checking":10000.0,"savings":5000.0,"card":0.0,"loan":0.0}
B = [
 Txn("checking",12000,"credit","income",income_class="earned"),
 Txn("savings",3000,"debit","transfer",internal=True),      # savings -> checking
 Txn("checking",3000,"credit","transfer",internal=True),
 Txn("checking",14000,"debit","purchase"),                  # spent more than salary
 Txn("savings",50,"credit","profit",income_class="passive"),# variable profit
]
bal_b = dict(OPEN_B)
for t in B:
    sign = 1 if t.direction=="credit" else -1
    if ACCOUNTS[t.acct]=="liability": sign = -sign
    bal_b[t.acct] += sign*t.amount

exp_b = sum(t.amount for t in B if t.direction=="debit" and not t.internal
            and t.type not in ("card_payment","loan_payment"))
earn_b = sum(t.amount for t in B if t.income_class=="earned")
pass_b = sum(t.amount for t in B if t.income_class=="passive")
inc_b  = earn_b + pass_b
nw_b   = sum(v for k,v in bal_b.items() if ACCOUNTS[k]=="asset") \
       - sum(v for k,v in bal_b.items() if ACCOUNTS[k]=="liability")
onw_b  = sum(v for k,v in OPEN_B.items() if ACCOUNTS[k]=="asset") \
       - sum(v for k,v in OPEN_B.items() if ACCOUNTS[k]=="liability")

deposits    = sum(t.amount for t in B if t.acct=="savings" and t.direction=="credit" and t.internal)
withdrawals = sum(t.amount for t in B if t.acct=="savings" and t.direction=="debit"  and t.internal)
net_contrib = deposits - withdrawals

print("balances        ", {k: round(v,2) for k,v in bal_b.items()})
print(f"income {inc_b} | expense {exp_b} | net worth {nw_b} (from {onw_b})")
print(f"savings rate     {(inc_b-exp_b)/inc_b*100:.1f}%   <- negative is CORRECT here")
print(f"net contribution {net_contrib}  (deposits {deposits} - withdrawals {withdrawals})")
print(f"savings balance  {bal_b['savings']} = 5000 principal - 3000 withdrawn + 50 profit")

assert abs((nw_b-onw_b) - (inc_b-exp_b)) < 0.01, "MASTER INVARIANT broken in scenario B"
assert (inc_b-exp_b) < 0, "this cycle should show a negative savings rate"
assert net_contrib == -3000, "net contribution must be able to go negative"
assert bal_b["savings"] == 2050, "profit must accrue into the same savings account"
print("\nSCENARIO B INVARIANTS PASS")
