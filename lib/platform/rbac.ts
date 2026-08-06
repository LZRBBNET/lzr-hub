export const roles=["Administrador","Supervisor","Atendente","Suporte","Cobrança","Comercial","Analista","Somente leitura"] as const;export type Role=typeof roles[number];
// "ixc.write" é permissão própria, separada de "billing.write-demo": esta
// grava só no nosso banco (meta, régua), aquela é o catálogo de escrita real
// no ERP (issue #20) — mesmo hoje bloqueado em três camadas antes de chegar
// ao IXC, o nome da permissão não deve confundir as duas coisas.
export const permissions=["customer.read","support.write","billing.write-demo","sales.write-demo","knowledge.publish","users.manage","audit.read","integrations.test","ixc.write"] as const;
export const rolePermissions:Record<Role,string[]>={Administrador:[...permissions],Supervisor:["customer.read","support.write","billing.write-demo","sales.write-demo","knowledge.publish","audit.read","integrations.test"],Atendente:["customer.read","support.write"],Suporte:["customer.read","support.write"],Cobrança:["customer.read","billing.write-demo","ixc.write"],Comercial:["customer.read","sales.write-demo"],Analista:["customer.read","audit.read"],"Somente leitura":["customer.read"]};
export function can(role:Role,permission:string){return rolePermissions[role].includes(permission)}
