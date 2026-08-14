import { integerValue } from './src/core/value.ts';
import { ProfileId } from './src/document/profile.ts';
import { JsonValue } from './src/json/document.ts';
import { commitEdits, EditTransactionBuilder } from './src/json/edit.ts';
import { parseDocument } from './src/registry.ts';

// 原生语义树成员查找（查询助手；完整操作符查询见 sdk_chain 示例）。
function member(value: JsonValue, name: string): JsonValue {
  const members = value.objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    throw new Error('not an object');
  }
  const m = members.value.find(
    (candidate) => candidate.name().kind === 'Available' && candidate.name().value === name,
  );
  if (m === undefined) throw new Error(`member '${name}' not found`);
  return m.value();
}

const source = new TextEncoder().encode('{"a":1,"b":{"c":2}}');
// 1. parse：json.strict 无损解析，render() 与源字节逐字节一致
const document = parseDocument(source, new ProfileId('json.strict', 1));
const json = document.asJson();
if (typeof json === 'string') throw new Error('not JSON');
// 2. query：原生语义树读 `b.c`
const c = member(member(json.root(), 'b'), 'c');
// 3. edit：`b.c` 语义替换为 42（CanonicalForProfile），编辑外字节原样保留
const transaction = new EditTransactionBuilder(json)
  .semanticScalar(c.nodeRef(), integerValue(42n), 'CanonicalForProfile')
  .build();
const edited = commitEdits(json, transaction).document();
// 4. render：输出 `{"a":1,"b":{"c":42}}`
console.log(new TextDecoder().decode(edited.render()));