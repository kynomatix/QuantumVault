// Frozen inventory counterfactual: the taker fee uses the slipped fill price.
export function heldEquity({cash,position,exitPrice,futureFunding,takerRate=0.0014,slippage=0.0005}){
 const fill=exitPrice*(1-Math.sign(position)*slippage);
 return cash+position*fill-futureFunding-Math.abs(position)*fill*takerRate;
}
