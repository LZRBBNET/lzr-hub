// Explicit permissions for demonstrated synthetic flows, not a universal app role.
export const grants=[
 'REVOKE ALL ON DATABASE lzr_synthetic_demo FROM PUBLIC',
 'REVOKE ALL ON SCHEMA public FROM PUBLIC',
 'GRANT CONNECT ON DATABASE lzr_synthetic_demo TO lzr_demo_app',
 'GRANT USAGE ON SCHEMA public TO lzr_demo_app',
 'GRANT SELECT ON public.users,public.customers,public.network_incidents,public.channel_messages,public.channel_contacts,public.agent_reply_templates,public.collection_rules,public.collection_rule_steps,public.collection_campaigns TO lzr_demo_app',
 'GRANT UPDATE (password_hash,password_salt,must_change_password,last_login_at,updated_at) ON public.users TO lzr_demo_app',
 'GRANT SELECT,INSERT,DELETE ON public.sessions TO lzr_demo_app',
 'GRANT INSERT ON public.audit_events TO lzr_demo_app',
 'GRANT SELECT,INSERT,UPDATE ON public.conversation_states TO lzr_demo_app',
 'GRANT SELECT,INSERT ON public.payment_promises TO lzr_demo_app',
 'GRANT UPDATE (status,updated_at) ON public.payment_promises TO lzr_demo_app',
 'GRANT SELECT,INSERT ON public.collection_dispatches TO lzr_demo_app',
];
