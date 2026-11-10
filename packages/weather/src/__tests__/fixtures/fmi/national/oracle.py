import xml.etree.ElementTree as E,pathlib,json,datetime,collections,math
p=pathlib.Path(__file__).parent
ns={'w':'http://www.opengis.net/wfs/2.0','g':'http://www.opengis.net/gml/3.2','e':'http://inspire.ec.europa.eu/schemas/ef/4.0','t':'http://xml.fmi.fi/namespace/om/atmosphericfeatures/1.1','c':'http://www.opengis.net/gmlcov/1.0','s':'http://www.opengis.net/swe/2.0'}
def name(n,k): return next((x.text for x in n.findall('.//g:name',ns) if x.get('codeSpace','').endswith('/'+k)),None)
def sid(n): return next(x.text for x in n.findall('.//g:identifier',ns) if x.get('codeSpace','').endswith('/fmisid'))
meta={}; counts={}; excluded=[]; duplicates=[]; future=[]; wrongNetwork=[]
at=datetime.datetime.fromisoformat(json.loads((p/"capture.json").read_text())[5]["retrievedAt"]).timestamp()
for num in [121,122,224]:
 r=E.parse(p/f'stations-{num}.xml').getroot(); members=r.findall('w:member',ns); assert str(len(members))==r.get('numberMatched')==r.get('numberReturned'); counts[str(num)]=len(members)
 for n in members:
  i=sid(n); xy=list(map(float,n.find('.//g:pos',ns).text.split()))
  if name(n,'country')!='Finland' or not (59<=xy[0]<=70.2 and 19<=xy[1]<=32): excluded.append(i); continue
  if not any(x.get('{http://www.w3.org/1999/xlink}href','').rstrip('&').split('networkid=')[-1] in ['121','122','224'] for x in n.findall('.//e:belongsTo',ns)): wrongNetwork.append(i); continue
  begin=n.find('.//g:beginPosition',ns).text
  if datetime.datetime.fromisoformat(begin.replace('Z','+00:00')).timestamp()>at: future.append(i); continue
  if i in meta: duplicates.append(i)
  meta[i]={'name':name(n,'name'),'lat':xy[0],'lon':xy[1]}
r=E.parse(p/'observations.xml').getroot(); assert r.get('numberMatched')==r.get('numberReturned')=='1'
locs={}
points={n.get('{'+ns['g']+'}id'):list(map(float,n.find('g:pos',ns).text.split())) for n in r.findall('.//g:Point',ns)}
for n in r.findall('.//t:Location',ns):
 ref=n.find('t:representativePoint',ns).get('{http://www.w3.org/1999/xlink}href')[1:]; lat,lon=points[ref]; key=(lat,lon); assert key not in locs; locs[key]=sid(n)
fields=[n.get('name') for n in r.findall('.//s:field',ns)]
positions=list(map(float,r.find('.//c:positions',ns).text.split())); values=r.find('.//g:doubleOrNilReasonTupleList',ns).text.split(); assert len(values)==len(positions)//3*len(fields)
at=datetime.datetime.fromisoformat(json.loads((p/'capture.json').read_text())[5]['retrievedAt']).timestamp(); latest={}; missing=collections.Counter(); seen=set()
for j in range(len(positions)//3):
 lat,lon,t=positions[j*3:j*3+3]; i=locs[(lat,lon)]
 for k,f in enumerate(fields):
  key=(i,t,f); assert key not in seen; seen.add(key); v=float(values[j*len(fields)+k]);
  if not math.isfinite(v): missing[f]+=1; continue
  if i not in meta or t>at or at-t>3600: continue
  key=i+':'+f
  if key not in latest or latest[key]['epoch']<=t: latest[key]={'stationId':i,'field':f,'value':v,'epoch':t,'lon':lon,'lat':lat}
out={'metadataMemberCounts':counts,'wrongNetwork':wrongNetwork,'futureMetadata':future,'selectedStations':len(meta),'duplicateMetadata':duplicates,'excludedMetadata':excluded,'observationStations':len(locs),'unmatchedObservationStations':sorted(set(locs.values())-set(meta)),'fields':fields,'positions':len(positions)//3,'tuples':len(values),'nonfinite':dict(missing),'acceptedReadings':len(latest),'stations':meta,'readings':latest}
(p/'oracle.json').write_text(json.dumps(out,indent=2)); print({k:v for k,v in out.items() if k not in ['stations','readings']})
