export function rejectionKind(reason){
 if(!reason)return null;
 if(reason==='Assumed round-trip cost is at least a cycle spread')return 'fee';
 if(/Investment cannot fund|Aggregate seed is below the opening minimum/.test(reason))return 'minimum';
 return 'other';
}
