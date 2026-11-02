import { describe, expect, it } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { prepareSelectedPrivatePublisher } from "./local-checks.ts";

const run=(cwd:string,...args:string[])=>execFileSync("git",args,{cwd,encoding:"utf8",env:{PATH:"/usr/bin:/bin",HOME:cwd,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_LAZY_FETCH:"1"}}).trim();
const fixture=(kind:"valid"|"changed"|"alias")=>{
  const root=mkdtempSync(path.join(tmpdir(),"gram-private-selected-"));
  const source=path.join(root,"source"), runroot=path.join(root,"private");mkdirSync(source);mkdirSync(runroot,{mode:0o700});
  writeFileSync(path.join(source,"visible.txt"),"synthetic public\n");
  run(source,"init","-q","--template=");run(source,"add","--","visible.txt");
  const secret=kind==="alias"?run(source,"hash-object","visible.txt"):execFileSync("git",["hash-object","-w","--stdin"],{cwd:source,input:"synthetic omitted object",encoding:"utf8"}).trim();
  run(source,"update-index","--add","--cacheinfo",`100644,${secret},.env.example`);
  run(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","base");
  const base=run(source,"rev-parse","HEAD");
  if(kind==="changed"){
    const replacement=execFileSync("git",["hash-object","-w","--stdin"],{cwd:source,input:"changed omitted object",encoding:"utf8"}).trim();
    run(source,"update-index","--cacheinfo",`100644,${replacement},.env.example`);
    run(source,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","head");
  }
  const head=run(source,"rev-parse","HEAD"),tree=run(source,"rev-parse","HEAD^{tree}");
  const entries=run(source,"ls-tree","-r","--full-tree",head).split("\n").map((line)=>{
    const [meta,name]=line.split("\t");const [mode,,oid]=meta!.split(" ");
    return {path:name!,mode:mode!,oid:oid!,selected:name!==".env.example"};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const raw=JSON.stringify({schema:"gram.selected-source/v1",head,base,tree,entries});
  const manifest=path.join(root,"selection.json");writeFileSync(manifest,raw);
  const store=path.join(runroot,"store.git"),publisher=path.join(runroot,"publisher");mkdirSync(store,{mode:0o700});mkdirSync(publisher,{mode:0o700});
  return {root,source,store,publisher,manifest,head,base,tree,secret,sha256:createHash("sha256").update(raw).digest("hex")};
};
const prepare=(f:ReturnType<typeof fixture>)=>Effect.runPromise(prepareSelectedPrivatePublisher(f.source,f.store,f.publisher,f.head,f.base,f.tree,{manifest:f.manifest,sha256:f.sha256}).pipe(Effect.provide(ProcLive)));

describe("private selected publisher preparation",()=>{
  it("prepares a private indexed worktree without selected or omitted checkout",async()=>{
    const f=fixture("valid");try{
      const result=await prepare(f);expect(result.tree).toBe(f.tree);
      expect(existsSync(path.join(f.publisher,".git"))).toBe(true);
      expect(existsSync(path.join(f.publisher,"visible.txt"))).toBe(false);
      expect(existsSync(path.join(f.publisher,".env.example"))).toBe(false);
      expect(run(f.publisher,"ls-files","--stage").split("\n")).toHaveLength(2);
      const missing=spawnSync("git",["cat-file","-e",f.secret],{cwd:f.store,encoding:"utf8",env:{PATH:"/usr/bin:/bin",HOME:f.root,GIT_NO_LAZY_FETCH:"1",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}});
      expect(missing.status).not.toBe(0);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  });
  it("refuses an omitted object changed between base and head",async()=>{
    const f=fixture("changed");try{
      await expect(prepare(f)).rejects.toThrow("private selected tree unavailable or differs");
      expect(existsSync(path.join(f.publisher,".git"))).toBe(false);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  });
  it("refuses an omitted blob aliased by selected content",async()=>{
    const f=fixture("alias");try{
      await expect(prepare(f)).rejects.toThrow("private selected tree unavailable or differs");
      expect(existsSync(path.join(f.publisher,".git"))).toBe(false);
    }finally{rmSync(f.root,{recursive:true,force:true});}
  });
});
