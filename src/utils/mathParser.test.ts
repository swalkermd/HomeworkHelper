import assert from 'node:assert/strict';
import { parseMathContent } from './mathParser';

type FractionNode = ReturnType<typeof parseMathContent>[number] & { type: 'fraction' };

function getFractions(content: string): FractionNode[] {
  return parseMathContent(content).filter(
    (node): node is FractionNode => node.type === 'fraction'
  );
}

(() => {
  const fractions = getFractions('\\( \\frac112 + \\frac38y = \\frac512 + \\frac58y \\)');

  assert.equal(fractions.length, 4, 'should parse four inline fractions');
  assert.equal(fractions[0]?.numerator, '1');
  assert.equal(fractions[0]?.denominator, '12');
  assert.equal(fractions[1]?.numerator, '3');
  assert.equal(fractions[1]?.denominator, '8');
  assert.equal(fractions[2]?.numerator, '5');
  assert.equal(fractions[2]?.denominator, '12');
  assert.equal(fractions[3]?.numerator, '5');
  assert.equal(fractions[3]?.denominator, '8');
})();

(() => {
  const [fraction] = getFractions('\\dfrac{11}{5}x');
  assert.equal(fraction?.numerator, '11');
  assert.equal(fraction?.denominator, '5');
})();

(() => {
  const nodes = parseMathContent('Area = \\tfrac34\\pi r^2');
  const fraction = nodes.find((n): n is FractionNode => n.type === 'fraction');
  assert.equal(fraction?.numerator, '3');
  assert.equal(fraction?.denominator, '4');

  const hasPi = nodes.some((node) => node.type === 'text' && node.content.includes('pi'));
  assert.ok(hasPi, 'should keep trailing text intact');
})();

console.log('mathParser tests passed');
