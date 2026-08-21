import { describe, expect, it } from "vitest";
import { alignFrames, assertStateTransition, compositeGeometry, durationFrameCount, timestampSecondsToUs } from "./capture-contract.js";
describe("capture contract",()=>{
 it("rounds CDP seconds to integer microseconds and rejects missing values",()=>{expect(timestampSecondsToUs(1.2345674)).toBe(1234567);expect(()=>timestampSecondsToUs(undefined)).toThrow();});
 it("computes exact duration and slot holds",()=>{expect(durationFrameCount(0,1000001,60)).toBe(61);const result=alignFrames([{offset:0,length:1,sequence:1,width:10,height:10,timestampUs:0},{offset:1,length:1,sequence:2,width:10,height:10,timestampUs:20000}],0,3,60);expect(result.mappings.map(x=>x.sourceSequence)).toEqual([1,1,2]);expect(result.heldFrames).toBe(1);});
 it("uses square-root grid and even bounded geometry",()=>{const result=compositeGeometry([{id:"a",encodedWidth:100,encodedHeight:80},{id:"b",encodedWidth:120,encodedHeight:90},{id:"c",encodedWidth:100,encodedHeight:80}],{width:200,height:200});expect(result.columns).toBe(2);expect(result.rows).toBe(2);expect(result.outputWidth%2).toBe(0);expect(result.outputHeight%2).toBe(0);expect(result.outputWidth).toBeLessThanOrEqual(200);});
 it("enforces state transitions",()=>{expect(()=>assertStateTransition("recording","encoding")).toThrow();expect(()=>assertStateTransition("recording","post-roll")).not.toThrow();});
});
