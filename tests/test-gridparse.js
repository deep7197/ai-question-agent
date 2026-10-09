/* Checks the grid reply parser against realistic AI output. */
const fs=require("fs"),vm=require("vm");
const src=fs.readFileSync("D:/ai-question-agent/chrome-extension/background.js","utf8");
const ctx={console,setTimeout,clearInterval,setInterval,URL,
  chrome:{storage:{local:{set(){},get(k,cb){if(cb)cb({});}},onChanged:{addListener(){}}},
    runtime:{sendMessage(){return Promise.resolve();},getPlatformInfo(){},
      onMessage:{addListener(){}},onInstalled:{addListener(){}},onStartup:{addListener(){}},
      onConnect:{addListener(){}}},
    tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
    alarms:{create(){},onAlarm:{addListener(){}}},
    debugger:{onDetach:{addListener(){}}}},
  WebSocket:function(){},importScripts(){}};
vm.createContext(ctx);
vm.runInContext(src+"\nthis.parseGridReply=parseGridReply;\nthis.rowKey=rowKey;\nthis.buildGridPrompt=buildGridPrompt;",ctx);

const headers=["Properties","Applications","Limitations"];
const rows=["1. Cements","2. Ceramics","3. Concrete","4. Engineered Timber Products","5. Flooring"];

const reply=`1. Cements | Properties: Fine powder that sets hard when mixed with water. | Applications: Binding agent in concrete and mortar. | Limitations: Weak in tension and absorbs moisture in storage.
2. Ceramics | Properties: Hard, brittle and resistant to heat. | Applications: Tiles, sanitary ware and cladding. | Limitations: Cracks under impact and point loads.
- 3. Concrete | Properties: High compressive strength and durable. | Applications: Slabs, footings and structural frames. | Limitations: Low tensile strength without reinforcement.
Engineered Timber Products | Properties: Manufactured from bonded timber layers. | Applications: Beams, flooring and wall framing. | Limitations: Vulnerable to moisture and fire.
Here is the table you asked for:`;

const got=ctx.parseGridReply(reply,rows,headers);
console.log("matched rows:", Object.keys(got).length, "of", rows.length);
rows.forEach(r=>{
  const c=got[ctx.rowKey(r)];
  console.log(" "+r+" -> "+(c?c.map(x=>x.slice(0,40)).join(" // "):"(missing, will be asked again)"));
});
console.log("\n--- prompt sample ---\n"+ctx.buildGridPrompt(
  {number:"4",text:"Briefly explain the following materials.",context:"",grid:{headers,rows}},
  rows.slice(0,2)));
