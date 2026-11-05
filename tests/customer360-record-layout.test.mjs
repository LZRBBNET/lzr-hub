import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import postcss from 'postcss';

const stylesheet=postcss.parse(readFileSync(new URL('../app/globals.css',import.meta.url),'utf8'));
const declarations=selector=>{
  const values={};stylesheet.walkRules(selector,rule=>rule.walkDecls(declaration=>{values[declaration.prop]=declaration.value;}));return values;
};

test('Customer360 record fields occupy separate flexible rows, including narrow containers',()=>{
  const list=declarations('.customer-record-list'),item=declarations('.customer-record-list > li');
  assert.equal(list.display,'grid');assert.equal(list.padding,'0');assert.equal(list['list-style'],'none');
  assert.equal(item.display,'grid');assert.equal(item['grid-template-columns'],'minmax(0, 1fr)');assert.equal(item['min-width'],'0');
  assert.equal(item['overflow-wrap'],'anywhere');assert.ok(parseFloat(item.gap)>0);assert.ok(parseFloat(list.gap)>0);
  for(const tag of ['strong','span','small'])assert.ok(declarations(`.customer-record-list > li > ${tag}`)['font-size']);
});

test('Customer360 record presentation uses shared light/dark theme colors',()=>{
  assert.equal(declarations('.customer-record-list > li').background,'var(--surface-2)');
  assert.equal(declarations('.customer-record-list > li > span').color,'var(--text-2)');
  assert.equal(declarations('.customer-record-list > li > small').color,'var(--muted)');
});

test('unstyled semantic lists remain explicitly exposed to assistive technology',()=>{
  const component=readFileSync(new URL('../components/modules/customer360.tsx',import.meta.url),'utf8');
  assert.equal((component.match(/<ul className="customer-record-list" role="list">/g)??[]).length,3);
});
