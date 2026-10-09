const fs=require("fs"),vm=require("vm");
const ctx={console,URL};vm.createContext(ctx);
vm.runInContext(fs.readFileSync("D:/ai-question-agent/chrome-extension/doc-reader.js","utf8")+
  "\nthis.extractBlocks=extractBlocks;\nthis.parseBlocks=parseBlocks;",ctx);

const html=`
<table><tr><td><p>Question 4. Briefly explain the properties, applications and limitations of the following building materials.</p></td></tr></table>
<table>
<tr><td><p>Building Material/Component</p></td><td><p>Properties</p></td><td><p>Applications</p></td><td><p>Limitations</p></td></tr>
<tr><td><p>1. Cements</p></td><td><p></p></td><td><p></p></td><td><p></p></td></tr>
<tr><td><p>2. Ceramics</p></td><td><p></p></td><td><p></p></td><td><p></p></td></tr>
<tr><td><p>3. Concrete</p></td><td><p></p></td><td><p></p></td><td><p></p></td></tr>
</table>
<p></p>
<table><tr><td><p>Question 5. Read the case study and answer the question.</p>
<p>A supplier delivers the wrong grade of steel.</p>
<p>Answer must be 50-100 words.</p>
<p>Satisfactory response</p><p>Yes &#9744;</p><p>No &#9744;</p></td></tr></table>
<p></p>
<table><tr><td><p></p></td></tr></table>
`;

const qs=ctx.parseBlocks(ctx.extractBlocks(html));
qs.forEach(q=>{
  console.log("["+q.number+"] kind="+q.kind+" space="+q.has_answer_space+
    (q.word_limit_min?" words="+q.word_limit_min+"-"+q.word_limit_max:""));
  console.log("   text: "+q.text.replace(/\n/g," | ").slice(0,90));
  if(q.grid) console.log("   grid: cols="+JSON.stringify(q.grid.headers)+
                         " rows="+JSON.stringify(q.grid.rows));
});
