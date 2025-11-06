# Production Quality Test Plan

## Test Questions

### Test 1: Algebra with Fractions
**Subject:** Algebra  
**Question:** Solve for x: (2/3)x + 5 = (1/4)x - 2  
**Expected Features:**
- ✓ Vertical fractions {2/3} and {1/4}
- ✓ Color highlighting for operations [blue:] and results [red:]
- ✓ Step-by-step solving (multiply to clear fractions, collect terms, solve)
- ✓ Final answer as simplified fraction (NO decimals)
- ✓ NO diagram needed

**Evaluation Criteria:**
- Formatting: Fractions vertical, colors used appropriately
- Clarity: Clear step progression, each operation explained
- Accuracy: Correct algebraic manipulation, right answer
- Efficiency: < 15 seconds
- Overall: Professional math homework helper quality

---

### Test 2: Geometry with Diagram
**Subject:** Geometry  
**Question:** A rectangle has a length of 12 cm and a width of 5 cm. Find the area and perimeter.  
**Expected Features:**
- ✓ SHOULD generate rectangle diagram with labeled dimensions
- ✓ Area formula and calculation
- ✓ Perimeter formula and calculation
- ✓ Units included (cm, cm²)
- ✓ Clear visual aid showing length and width

**Evaluation Criteria:**
- Image Generation: Should create labeled rectangle diagram
- Clarity: Formula → substitution → answer pattern
- Accuracy: Correct formulas and calculations
- Formatting: Clean presentation with units
- Overall: Should help student visualize the problem

---

### Test 3: Chemistry Equation
**Subject:** Chemistry  
**Question:** Balance this equation: H2 + O2 → H2O  
**Expected Features:**
- ✓ Subscripts: H_2_, O_2_
- ✓ Balanced equation: 2H_2_ + O_2_ → 2H_2_O
- ✓ Step-by-step balancing process
- ✓ Explanation of atom counting
- ✓ NO diagram needed (unless process illustration)

**Evaluation Criteria:**
- Formatting: Subscripts correctly formatted
- Clarity: Atom counting explained clearly
- Accuracy: Correctly balanced equation
- Educational Value: Teaches balancing method
- Overall: Chemistry student should understand the process

---

### Test 4: Physics Motion
**Subject:** Physics  
**Question:** A car accelerates from rest at 3 m/s². How far does it travel in 5 seconds?  
**Expected Features:**
- ✓ Kinematic equation: d = v₀t + {1/2}at²
- ✓ Substitution with units
- ✓ Calculation steps
- ✓ Final answer with units (meters)
- ? Optional: motion diagram (AI should decide)

**Evaluation Criteria:**
- Formatting: Subscripts for v₀, superscripts for t²
- Clarity: Formula identification, substitution, solve
- Accuracy: Correct formula and calculation
- Image Decision: Reasonable choice whether to include diagram
- Overall: Clear physics problem solving

---

### Test 5: Fraction Word Problem
**Subject:** Math (Word Problem)  
**Question:** Sarah has 3/4 of a pizza. She eats 1/3 of what she has. How much pizza does she have left?  
**Expected Features:**
- ✓ Vertical fractions throughout
- ✓ Fraction multiplication: {3/4} × {1/3}
- ✓ Fraction subtraction: {3/4} - {1/4}
- ✓ Final answer as FRACTION, NOT decimal
- ✓ Word problem interpretation clear
- ✓ NO diagram needed

**Evaluation Criteria:**
- Formatting: CRITICAL - All fractions vertical, NO decimals
- Clarity: Interprets "1/3 of what she has" correctly
- Accuracy: Correct fraction arithmetic
- Compliance: Must NOT convert to 0.5 or similar
- Overall: Follows fraction-only mandate

---

## Scoring Rubric (Per Question)

### Formatting (0-10)
- 10: Perfect formatting, all fractions vertical, colors used, proper syntax
- 7-9: Minor formatting issues
- 4-6: Significant formatting problems
- 0-3: Major violations (decimals instead of fractions, missing colors)

### Clarity (0-10)
- 10: Crystal clear, perfect step count, excellent explanations
- 7-9: Clear with minor verbosity or brevity issues
- 4-6: Somewhat confusing or missing steps
- 0-3: Unclear or missing critical explanations

### Accuracy (0-10)
- 10: Completely correct
- 7-9: Correct with minor notation issues
- 4-6: Correct method but calculation errors
- 0-3: Wrong approach or answer

### Image Generation (0-10)
- 10: Perfect decision (generated when helpful, skipped when not)
- 7-9: Acceptable decision
- 4-6: Questionable choice
- 0-3: Wrong decision (missing needed diagram or unnecessary diagram)

### Efficiency (0-10)
- 10: < 10 seconds
- 8-9: 10-15 seconds
- 5-7: 15-20 seconds
- 0-4: > 20 seconds

### Overall (Average of above)
- 9-10: Production ready, excellent quality
- 7-8: Production ready with minor polish needed
- 5-6: Needs improvements before production
- 0-4: Significant work required

## Production Readiness Criteria

**PASS (Production Ready):**
- Average score ≥ 7.5 across all questions
- No individual question < 6
- No critical formatting violations (decimals instead of fractions)
- Efficiency target met (< 15s average)

**CONDITIONAL PASS:**
- Average score 6.5-7.4
- All questions ≥ 5
- Minor improvements needed

**FAIL (Not Production Ready):**
- Average score < 6.5
- Any question < 5
- Critical violations present
