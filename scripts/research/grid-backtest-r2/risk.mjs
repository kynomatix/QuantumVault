// Pure research accounting. Positive funding is paid by a long and received by a short.
export const maintenanceRate=maxLeverage=>1/(2*maxLeverage);
export function liquidationPrice(cash,signedQuantity,maxLeverage){
 if(!signedQuantity)return null;
 const q=Math.abs(signedQuantity),sign=Math.sign(signedQuantity);
 return cash/(q*(maintenanceRate(maxLeverage)-sign));
}
export function liquidationCrossing(cash,signedQuantity,maxLeverage,from,to){
 if(!signedQuantity)return null;
 const margin=price=>cash+signedQuantity*price-Math.abs(signedQuantity)*price*maintenanceRate(maxLeverage);
 if(margin(from)<=0)return 0;
 if(margin(to)>0)return null;
 return Math.max(0,Math.min(1,(liquidationPrice(cash,signedQuantity,maxLeverage)-from)/(to-from)));
}
export const liquidationChargeRate=maxLeverage=>Math.max(0.0075,maintenanceRate(maxLeverage)*0.4);
