// Isolated visual QA with synthetic staff, assignments and attendance logs.
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "vite";
mkdirSync("output/playwright", { recursive: true });
writeFileSync(
  "output/playwright/shift-definitions.html",
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRootRoute,createRoute,createRouter,RouterProvider} from '@tanstack/react-router';
import {Route} from '/src/routes/_app/shift.tsx';
import '/src/styles.css';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Lagos',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const staff=['Saved definition','Definition unavailable','Legacy schedule','Off only'].map((name,i)=>({id:'n'+(i+1),name,role:'Nurse',ward:'General',facility:'Ikoyi',target_hours:180,is_active:true}));
const definition={code:'M',name:'Early day duty',start:'08:00',end:'17:00',endDayOffset:0,breakMinutes:90,creditedMinutes:450,color:'#123456',timezone:'Africa/Lagos',startsAt:today+'T07:00:00Z',endsAt:today+'T16:00:00Z',source:'saved_run',runId:'run1'};
const assignments=staff.map((n,i)=>({id:'a'+i,nurse_id:n.id,shift:i===3?'OFF':'M',shift_date:today,ward:'General',status:'published',scheduled_shift:i===0?definition:null,shift_definition_error:i===1?'Saved shift definition is unavailable':null}));
const attendanceDemo=new URLSearchParams(location.search).has('active');
let completed=!attendanceDemo;
window.fixtureWrites=[];
window.fetch=async(url,opts={})=>{
 const parsed=new URL(url,location.origin),path=parsed.pathname;let data=[];
 if(opts.method&&opts.method!=='GET') {
   window.fixtureWrites.push({path,method:opts.method});
   if(attendanceDemo&&opts.method==='PATCH'&&path.endsWith('/shift-logs/log1')) {
     completed=true;
     return new Response(JSON.stringify({hours_logged:7.5,hours_credited_by_server:true}),{headers:{'Content-Type':'application/json'}});
   }
   throw new Error('Isolated fixture blocked mutation');
 }
 if(path.endsWith('/nurses')) data=parsed.searchParams.has('id')?staff.filter(n=>n.id===parsed.searchParams.get('id')):staff;
 else if(path.endsWith('/shift-assignments')) data=assignments.filter(a=>(!parsed.searchParams.has('nurse_id')||a.nurse_id===parsed.searchParams.get('nurse_id'))&&(!parsed.searchParams.has('shift_date')||a.shift_date===parsed.searchParams.get('shift_date')));
 else if(path.endsWith('/shift-logs/current')) data={id:'log1',nurse_id:'n1',shift_date:today,shift_type:'M',started_at:definition.startsAt,expected_end_at:definition.endsAt,ended_at:completed?definition.endsAt:null,hours_logged:completed?7.5:null};
 else if(path.includes('/portal-settings/')) data={value:{}};
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
const rootRoute=createRootRoute();
const demoRoute=createRoute({getParentRoute:()=>rootRoute,path:'/output/playwright/shift-definitions.html',component:()=>React.createElement('main',{className:'max-w-6xl mx-auto p-5'},React.createElement(Route.options.component))});
const router=createRouter({routeTree:rootRoute.addChildren([demoRoute])});
createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(RouterProvider,{router})));
</script></body></html>`,
);
const server = await createServer({
  server: { host: "127.0.0.1", port: 5176, strictPort: true },
  plugins: [
    {
      name: "synthetic-shift-auth",
      enforce: "pre",
      load(id) {
        if (id.replaceAll("\\", "/").endsWith("/src/lib/auth-context.tsx"))
          return `
        export function useAuth(){const staff=new URLSearchParams(location.search).has('staff');return {nurseId:staff?'n1':null,fullName:'Demo nurse',activeRole:staff?'nurse':'admin',isStaffAccount:staff};}
      `;
      },
    },
  ],
});
await server.listen();
console.log("Synthetic Shift page: http://127.0.0.1:5176/output/playwright/shift-definitions.html");
