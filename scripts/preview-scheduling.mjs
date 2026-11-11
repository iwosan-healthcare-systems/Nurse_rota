// Local visual QA harness. Uses synthetic fixtures and intercepts all API calls.
// Run with node scripts/preview-scheduling.mjs, then open the printed URL.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "vite";
const require = createRequire(import.meta.url);
const { seedConfiguration } = require("../nurse-api/lib/scheduling-configuration");
const { generateConfiguredPreview } = require("../nurse-api/lib/configured-scheduler");
const facility = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Demo Hospital",
  legacy_facility: "Demo Hospital",
  timezone: "Africa/Lagos",
  organization_id: "demo",
};
const wards = ["General Ward", "Emergency"].map((name, i) => ({
  id: `20000000-0000-4000-8000-00000000000${i}`,
  name,
  min_morning_nurses: 3,
  min_morning_na: 1,
  min_night_nurses: 2,
  min_night_na: 1,
}));
const configuration = seedConfiguration(facility, wards);
const fixture = { facility, defaults: { configuration, wards, warnings: [] } };
mkdirSync("output/playwright", { recursive: true });
writeFileSync(
  "output/playwright/scheduling.html",
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {SchedulingConfigurationEditor} from '/src/components/settings/SchedulingConfiguration.tsx';
import '/src/styles.css';
const fixture=${JSON.stringify(fixture)};
if(new URLSearchParams(location.search).has('zero-minima')) fixture.defaults.configuration.requirements.forEach(r=>r.minimum=0);
const versions=[];
const runs=[];
let policy=null;
const originalFetch=window.fetch.bind(window);
window.fetch=async (url,opts={})=>{
 const path=new URL(url,location.origin).pathname;
 if(!path.includes('/scheduling/')) throw new Error('QA harness blocked nonfixture request');
 const method=opts.method||'GET';const body=opts.body?JSON.parse(opts.body):{};
 let data;let status=200;
 if(path.endsWith('/defaults')) data=fixture.defaults;
 else if(path.endsWith('/active')) data={policy};
 else if(method==='POST'&&path.endsWith('/activate')) {const run=runs.find(r=>path.endsWith('/'+r.runId+'/activate'));policy={state:'active',effective_from:run.startDate,source_run_id:run.runId};data=policy;window.fixtureActivations=(window.fixtureActivations||0)+1;}
 else if(method==='POST'&&path.endsWith('/pause')) {policy={state:'paused',effective_from:'1900-01-01'};data=policy;}
 else if(method==='POST'&&path.endsWith('/generate-active')) {if(policy?.state!=='active'){status=409;data={error:'Configured generation is paused'};}else{data={written:runs.find(r=>r.runId===policy.source_run_id).assignments.length};window.fixtureActiveWrites=(window.fixtureActiveWrites||0)+1;}}
 else if(method==='POST'&&path.endsWith('/draft')) {const run=runs.find(r=>path.endsWith('/'+r.runId+'/draft'));if(!run||run.hasBlockingIssues){status=422;data={error:'Resolve preview issues before creating a draft'};}else{data={written:run.assignments.length,runId:run.runId};window.fixtureDraftWrites=(window.fixtureDraftWrites||0)+1;}}
 else if(method==='GET'&&path.endsWith('/runs')) data={runs:runs.map(r=>({id:r.runId,configuration_version:r.configurationVersion,configuration_revision:r.configurationRevision,start_date:r.startDate,created_at:r.savedAt}))};
 else if(method==='GET'&&path.includes('/runs/')) data=runs.find(r=>path.endsWith('/'+r.runId));
 else if(path.endsWith('/preview')||(method==='POST'&&path.endsWith('/runs'))) {const version=versions.find(v=>path.includes('/'+v.id+'/'));const response=await originalFetch('/__scheduling-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({configuration:version.configuration,...body,configurationId:version.id,configurationVersion:version.version,configurationRevision:version.revision})});if(!response.ok||path.endsWith('/preview'))return response;data={...await response.json(),runId:'run'+(runs.length+1),savedAt:new Date().toISOString()};runs.push(structuredClone(data));}
 else if(path.endsWith('/validate')) data={valid:true,errors:[],warnings:[]};
 else if(method==='PUT'&&window.simulateConflict){window.simulateConflict=false;status=409;data={error:'Configuration changed; reload before saving'};}
 else if(method==='POST'){data={id:'v'+(versions.length+1),version:versions.length+1,revision:1,status:'draft',configuration:body.configuration,warnings:[]};versions.push(data);}
 else if(method==='PUT'){data=versions.find(v=>path.endsWith('/'+v.id));data.configuration=body.configuration;data.revision++;}
 else if(path.endsWith('/versions'))data={versions};
 else data=versions.find(v=>path.endsWith('/'+v.id));
 return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
};
function App(){const [manage,setManage]=React.useState(true);const [dirty,setDirty]=React.useState(false);const [busy,setBusy]=React.useState(false);return React.createElement('main',{className:'mx-auto max-w-6xl p-5'},React.createElement('h1',{className:'mb-4 text-2xl font-bold'},'Scheduling configuration'),React.createElement('div',{className:'mb-4 flex gap-4'},React.createElement('button',{onClick:()=>setManage(v=>!v)},manage?'Switch to read-only':'Switch to manager'),React.createElement('button',{onClick:()=>window.simulateConflict=true},'Simulate stale save'),React.createElement('span',null,dirty?'Unsaved':'Clean')),React.createElement(SchedulingConfigurationEditor,{facility:fixture.facility,canManage:manage,onDirtyChange:setDirty,onBusyChange:setBusy}));}
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(App)));
</script></body></html>`,
);
const previewHandler = (req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    try {
      const input = JSON.parse(body);
      const nurses = Array.from({ length: 12 }, (_, i) => ({
        id: `demo-${i}`,
        name: `Demo nurse ${i + 1}`,
        role: "Nurse",
        ward: wards[i % 2].name,
        facility: facility.legacy_facility,
        target_hours: 150,
      }));
      const preview = generateConfiguredPreview({
        configuration: input.configuration,
        facility,
        wards,
        nurses,
        startDate: input.startDate,
        anchorDate: input.anchorDate || input.startDate,
      });
      res.end(
        JSON.stringify({
          ...preview,
          configurationId: input.configurationId,
          configurationVersion: input.configurationVersion,
          configurationRevision: input.configurationRevision,
          generatedAt: new Date().toISOString(),
          shiftDefinitions: input.configuration.shifts,
          wardDefinitions: wards.map((w) => ({ id: w.id, name: w.name })),
        }),
      );
    } catch (error) {
      res.statusCode = 422;
      res.end(JSON.stringify({ error: error.message, errors: error.errors }));
    }
  });
};
const server = await createServer({
  server: { host: "127.0.0.1", port: 5175, strictPort: true },
  plugins: [
    {
      name: "synthetic-scheduling-preview",
      configureServer(vite) {
        vite.middlewares.use("/__scheduling-preview", previewHandler);
      },
    },
  ],
});
await server.listen();
console.log(
  "Synthetic scheduling preview: http://127.0.0.1:5175/output/playwright/scheduling.html",
);
