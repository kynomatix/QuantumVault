export interface WorkerBotName {id:string;name:string|null;market:string}
export function gridWorkerBotNames(bots:readonly WorkerBotName[]):ReadonlyMap<string,string> {
  return new Map(bots.map(b=>[b.id,b.name||b.market||'A grid bot']));
}
