import { deflateRawSync } from 'node:zlib';

export const scenarioFormatVersion = '1.59';

const playerCapacity = 16;
const gaiaPlayerIndex = 8;
const unitSections = 9;
const noStringId = 0xfffffffe;
const sectionSeparator = 0xffffff9d;
const stringMarker = 0x0a60;
const triggerVersion = 5;
const effectFieldCount = 83;
const scriptCallEffect = 55;
const headerNumbers = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19];
const defaultScoreVictory = 14000;
const defaultTimedVictory = 9000;
const stanceAlly = 0;
const stanceEnemy = 3;
const aiGaia = 0;
const aiSelf = 1;
const aiAlly = 2;
const aiEnemy = 4;
const randomCivilization = 'RANDOM-CIV';

export interface ScenarioPlayer {
  slot: number;
  colorIndex: number;
  team: number;
  startX: number;
  startY: number;
  food: number;
  wood: number;
  gold: number;
  stone: number;
  startingAge: number;
  populationCap: number;
}

export interface ScenarioObject {
  objectId: number;
  owner: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  frame: number;
}

export interface ScenarioTrigger {
  name: string;
  description: string;
  scriptCall: string;
}

export interface ScenarioInput {
  width: number;
  height: number;
  terrain: Uint8Array;
  elevation: Uint8Array;
  layer: Int16Array;
  players: ScenarioPlayer[];
  objects: ScenarioObject[];
  instructions: string;
  fileName: string;
  creator: string;
  xsScriptName: string;
  triggers: ScenarioTrigger[];
  timestamp: number;
}

class ByteWriter {
  private buffer = new Uint8Array(1 << 16);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private reserve(bytes: number): void {
    if (this.length + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + bytes) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  s8(value: number): void {
    this.reserve(1);
    this.view.setInt8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, value, true);
    this.length += 2;
  }

  s16(value: number): void {
    this.reserve(2);
    this.view.setInt16(this.length, value, true);
    this.length += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value >>> 0, true);
    this.length += 4;
  }

  s32(value: number): void {
    this.reserve(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  f32(value: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number): void {
    this.reserve(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  bytes(value: Uint8Array): void {
    this.reserve(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  zeros(count: number): void {
    this.reserve(count);
    this.buffer.fill(0, this.length, this.length + count);
    this.length += count;
  }

  str16(value: string, terminated = true): void {
    const text = encodeText(value, terminated);
    if (text.length > 0xffff) throw new Error('scenario string too long');
    this.u16(text.length);
    this.bytes(text);
  }

  str32(value: string, terminated = true): void {
    const text = encodeText(value, terminated);
    this.u32(text.length);
    this.bytes(text);
  }

  chars(value: string, size: number): void {
    const text = new TextEncoder().encode(value);
    if (text.length > size) throw new Error('scenario field too long');
    this.bytes(text);
    this.zeros(size - text.length);
  }

  result(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function encodeText(value: string, terminated: boolean): Uint8Array {
  const text = new TextEncoder().encode(value);
  if (!terminated) return text;
  const out = new Uint8Array(text.length + 1);
  out.set(text);
  return out;
}

export function validateScenarioInput(input: ScenarioInput): void {
  const tiles = input.width * input.height;
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > 480 ||
    input.height > 480
  ) {
    throw new Error('scenario map size is out of range');
  }
  if (
    input.terrain.length !== tiles ||
    input.elevation.length !== tiles ||
    input.layer.length !== tiles
  ) {
    throw new Error('scenario tile columns do not match the map size');
  }
  if (input.players.length < 1 || input.players.length > 8) {
    throw new Error('scenario needs 1 to 8 players');
  }
  const slots = new Set<number>();
  for (const player of input.players) {
    if (
      !Number.isInteger(player.slot) ||
      player.slot < 1 ||
      player.slot > 8 ||
      slots.has(player.slot)
    ) {
      throw new Error('scenario player slots must be unique, 1 to 8');
    }
    slots.add(player.slot);
  }
  for (const object of input.objects) {
    if (
      !Number.isInteger(object.objectId) ||
      object.objectId < 0 ||
      object.objectId > 0xffff ||
      !Number.isInteger(object.owner) ||
      object.owner < 0 ||
      object.owner > 8 ||
      ![object.x, object.y, object.z, object.rotation].every(Number.isFinite) ||
      !Number.isInteger(object.frame) ||
      object.frame < 0 ||
      object.frame > 0xffff
    ) {
      throw new Error('scenario object is invalid');
    }
  }
}

export function writeScenario(input: ScenarioInput): Uint8Array {
  validateScenarioInput(input);
  const header = new ByteWriter();
  writeHeader(header, input);
  const body = new ByteWriter();
  writeDataHeader(body, input);
  writeMessages(body, input);
  writeCinematicsAndBackground(body);
  writePlayerDataTwo(body, input);
  writeGlobalVictory(body);
  writeDiplomacy(body, input);
  writeOptions(body, input);
  writeMap(body, input);
  writeUnits(body, input);
  writeTriggers(body, input);
  writeFiles(body, input);
  const compressed = deflateRawSync(body.result(), { level: 9 });
  const file = new Uint8Array(header.length + compressed.length);
  file.set(header.result());
  file.set(compressed, header.length);
  return file;
}

function playerBySlot(input: ScenarioInput): Map<number, ScenarioPlayer> {
  return new Map(input.players.map((player) => [player.slot, player]));
}

function playerCount(input: ScenarioInput): number {
  return Math.max(...input.players.map((player) => player.slot));
}

function writeHeader(writer: ByteWriter, input: ScenarioInput): void {
  writer.bytes(new TextEncoder().encode(scenarioFormatVersion));
  writer.u32(0);
  writer.s32(6);
  writer.u32(input.timestamp);
  writer.str32(input.instructions);
  writer.u32(playerCount(input));
  writer.u32(1000);
  writer.u32(1);
  writer.u32(headerNumbers.length);
  for (const value of headerNumbers) writer.u32(value);
  writer.str32(input.creator);
  writer.u32(input.triggers.length);
}

function writeDataHeader(writer: ByteWriter, input: ScenarioInput): void {
  writer.u32(input.objects.length);
  writer.f32(Number(scenarioFormatVersion));
  writer.s32(playerCapacity);
  writer.s32(gaiaPlayerIndex);
  for (let index = 0; index < playerCapacity; index += 1) writer.zeros(256);
  for (let index = 0; index < playerCapacity; index += 1) writer.u32(noStringId);
  const count = playerCount(input);
  for (let index = 0; index < playerCapacity; index += 1) {
    writer.u32(index < count ? 1 : 0);
    writer.u32(1);
    writer.u16(stringMarker);
    writer.str16(randomCivilization, false);
    writer.u16(stringMarker);
    writer.str16(randomCivilization, false);
    writer.u32(4);
  }
  for (let index = 0; index < playerCapacity * 2; index += 1) writer.u32(0);
  writer.bytes(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0));
  writer.str16(input.fileName, false);
}

function writeMessages(writer: ByteWriter, input: ScenarioInput): void {
  for (let index = 0; index < 6; index += 1) writer.u32(noStringId);
  writer.str16(input.instructions, false);
  for (let index = 0; index < 5; index += 1) writer.str16('', false);
}

function writeCinematicsAndBackground(writer: ByteWriter): void {
  for (let index = 0; index < 3; index += 1) writer.str16('', false);
  writer.str16('', false);
  writer.u32(3);
  writer.u32(0);
  writer.s32(0);
  writer.s16(1);
}

function writePlayerDataTwo(writer: ByteWriter, input: ScenarioInput): void {
  for (let index = 0; index < 32; index += 1) writer.str16('', false);
  for (let index = 0; index < playerCapacity; index += 1) writer.str16('', false);
  for (let index = 0; index < playerCapacity; index += 1) {
    writer.zeros(8);
    writer.str32('', false);
  }
  for (let index = 0; index < playerCapacity; index += 1) writer.u8(1);
  writer.u32(sectionSeparator);
  const players = playerBySlot(input);
  for (let index = 0; index < playerCapacity; index += 1) {
    const player = players.get(index + 1);
    writer.s32(player?.gold ?? 0);
    writer.s32(player?.wood ?? 0);
    writer.s32(player?.food ?? 0);
    writer.s32(player?.stone ?? 0);
    writer.s32(0);
    writer.s32(0);
    writer.s32(player?.colorIndex ?? index);
  }
}

function writeGlobalVictory(writer: ByteWriter): void {
  writer.u32(sectionSeparator);
  writer.u32(1);
  for (let index = 0; index < 6; index += 1) writer.u32(0);
  writer.u32(0);
  writer.u32(defaultScoreVictory);
  writer.u32(defaultTimedVictory);
}

function allied(input: ScenarioInput, left: number, right: number): boolean {
  if (left === right) return true;
  const players = playerBySlot(input);
  const a = players.get(left)?.team ?? 0;
  const b = players.get(right)?.team ?? 0;
  return a !== 0 && a === b;
}

function writeDiplomacy(writer: ByteWriter, input: ScenarioInput): void {
  for (let row = 0; row < playerCapacity; row += 1) {
    for (let column = 0; column < playerCapacity; column += 1) {
      const alliedPair =
        row < 8 && column < 8 && row !== column && allied(input, row + 1, column + 1);
      writer.u32(alliedPair ? stanceAlly : stanceEnemy);
    }
  }
  writer.zeros(11520);
  writer.u32(sectionSeparator);
  for (let index = 0; index < playerCapacity; index += 1) writer.u32(0);
  writer.u8(0);
  writer.u8(1);
  writer.u8(0);
  writer.u8(4);
}

function writeOptions(writer: ByteWriter, input: ScenarioInput): void {
  for (let list = 0; list < 3; list += 1) {
    for (let index = 0; index < playerCapacity; index += 1) writer.u32(0);
  }
  writer.u32(0);
  writer.u32(0);
  writer.u32(0);
  const players = playerBySlot(input);
  for (let index = 0; index < playerCapacity; index += 1) {
    writer.u32(players.get(index + 1)?.startingAge ?? 2);
  }
  writer.u32(sectionSeparator);
  for (let index = 0; index < 8; index += 1) writer.u8(0xff);
  writer.s32(0);
  writer.u8(0);
  writer.zeros(8);
  writer.zeros(7);
  writer.u32(input.triggers.length);
}

function writeMap(writer: ByteWriter, input: ScenarioInput): void {
  writer.u16(stringMarker);
  writer.str16('Default', false);
  writer.u16(stringMarker);
  writer.str16('Default', false);
  writer.u16(stringMarker);
  writer.str16(input.xsScriptName, false);
  writer.u8(0);
  writer.u8(0);
  const players = playerBySlot(input);
  for (let index = 0; index < playerCapacity; index += 1) {
    const player = players.get(index + 1);
    writer.s32(player ? Math.floor(player.startX) : -1);
    writer.s32(player ? Math.floor(player.startY) : -1);
  }
  writer.u8(0);
  for (let index = 0; index < playerCapacity; index += 1) {
    writer.u32(players.get(index + 1)?.populationCap ?? 200);
  }
  writer.u32(0);
  writer.bytes(Uint8Array.of(0x0d, 0xf0, 0xad, 0xde));
  writer.bytes(Uint8Array.of(0x02, 0x00, 0x00, 0x00));
  writer.s8(0);
  writer.s32(input.width);
  writer.s32(input.height);
  for (let tile = 0; tile < input.width * input.height; tile += 1) {
    writer.u8(input.terrain[tile]!);
    writer.u8(input.elevation[tile]!);
    writer.bytes(Uint8Array.of(0x00, 0xff, 0xff));
    writer.s16(input.layer[tile]!);
  }
}

function writeUnits(writer: ByteWriter, input: ScenarioInput): void {
  const players = playerBySlot(input);
  writer.u32(unitSections);
  for (let index = 0; index < 8; index += 1) {
    const player = players.get(index + 1);
    writer.f32(player?.food ?? 0);
    writer.f32(player?.wood ?? 0);
    writer.f32(player?.gold ?? 0);
    writer.f32(player?.stone ?? 0);
    writer.f32(0);
    writer.f32(0);
    writer.f32(player?.populationCap ?? 200);
  }
  writer.u32(unitSections);
  for (let index = 0; index < 8; index += 1) {
    const slot = index + 1;
    const player = players.get(slot);
    const centreX = player?.startX ?? input.width / 2;
    const centreY = player?.startY ?? input.height / 2;
    writer.str16('Scenario Editor Phantom');
    writer.f32(centreX);
    writer.f32(centreY);
    writer.s16(Math.floor(centreX));
    writer.s16(Math.floor(centreY));
    writer.u8(0);
    writer.u16(unitSections);
    for (let other = 0; other <= 8; other += 1) {
      writer.u8(
        other === slot
          ? stanceAlly
          : other !== 0 && allied(input, slot, other)
            ? stanceAlly
            : stanceEnemy,
      );
    }
    for (let other = 0; other <= 8; other += 1) {
      writer.u32(
        other === 0
          ? aiGaia
          : other === slot
            ? aiSelf
            : allied(input, slot, other)
              ? aiAlly
              : aiEnemy,
      );
    }
    writer.u32(player?.colorIndex ?? index);
    writer.f32(2.1);
    writer.u16(0);
    writer.zeros(7);
    writer.u8(0);
    writer.zeros(7);
    writer.s32(-1);
  }
  for (let owner = 0; owner < unitSections; owner += 1) {
    const owned = input.objects
      .map((object, index) => ({ object, index }))
      .filter(({ object }) => object.owner === owner);
    writer.u32(owned.length);
    for (const { object, index } of owned) {
      writer.f32(object.x);
      writer.f32(object.y);
      writer.f32(object.z);
      writer.s32(index);
      writer.u16(object.objectId);
      writer.u8(2);
      writer.f32(object.rotation);
      writer.u16(object.frame);
      writer.s32(-1);
      writer.s8(-1);
      writer.s32(-1);
      writer.str32('', false);
    }
  }
}

function writeTriggers(writer: ByteWriter, input: ScenarioInput): void {
  writer.f64(triggerVersion);
  writer.s8(0);
  writer.s32(input.triggers.length);
  for (const trigger of input.triggers) {
    writer.u32(0);
    writer.s8(0);
    writer.s8(0);
    writer.s32(0);
    writer.u8(0);
    writer.u32(0);
    writer.u8(0);
    writer.s32(0);
    writer.u8(0);
    writer.zeros(5);
    writer.u8(0);
    writer.str32(trigger.description);
    writer.str32(trigger.name);
    writer.str32('');
    writer.s32(1);
    writeScriptCallEffect(writer, trigger.scriptCall);
    writer.s32(0);
    writer.s32(0);
  }
  for (let index = 0; index < input.triggers.length; index += 1) writer.u32(index);
  writer.zeros(1028);
  writer.u32(0);
  writer.zeros(9);
  writer.zeros(8);
  writer.zeros(16);
  writer.u8(0);
}

function writeScriptCallEffect(writer: ByteWriter, script: string): void {
  writer.s32(scriptCallEffect);
  writer.s32(effectFieldCount);
  for (let index = 0; index < effectFieldCount; index += 1) {
    if (index === quantityFloatField) writer.f32(-1);
    else writer.s32(-1);
  }
  writer.str32(script);
  writer.str32('', false);
  writer.str32('');
  writer.str32('');
}

const quantityFloatField = 70;

function writeFiles(writer: ByteWriter, input: ScenarioInput): void {
  writer.str16(input.xsScriptName.length > 0 ? `${input.xsScriptName}.xs` : '', false);
  writer.str32('', false);
  writer.u32(0);
  writer.u32(0);
}
