// The preregistration admits HYPE/ZEC only in their direct-Pacific a periods.
// Older proxy confirmation is restricted to BTC, ETH and SOL.
export function inRegisteredPopulation(row){
 return row.period!=='proxy'||['BTC','ETH','SOL'].includes(row.market??row.symbol);
}
