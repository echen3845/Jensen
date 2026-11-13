import {describe,expect,it,vi} from "vitest";
import {actualChatCost,chatReservation} from "../lib/quotas";
describe("provider retry cost reservations",()=>{
 it("reserves each possible attempt and does not refund unreported retry costs",()=>{
  const messages=[{content:"Hello"}],response={usage:{input_tokens:2,output_tokens:3}};
  const base=chatReservation(messages,10);
  expect(actualChatCost(response)).toBe(5);
  vi.stubEnv("JENSEN_PROVIDER_RETRIES","2");
  expect(chatReservation(messages,10)).toBe(base*3);
  expect(actualChatCost(response)).toBeUndefined();
 });
 it("charges the hold when the provider omits usage",()=>{
  expect(actualChatCost({})).toBeUndefined();
 });
});
